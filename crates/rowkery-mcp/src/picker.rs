//! What the Agents page's Edit access lists: a connection's databases with
//! their sizes, and one database's tables by schema with row estimates. The
//! app calls it in-process, through the same read-only sessions and catalog
//! cache the server uses, for any saved connection, shared or not.

use rowkery_core::config::AppConfig;
use rowkery_core::db::TableKind;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::guard::BIG_TABLE_ROWS;
use crate::target::{any, Store};

#[derive(Debug, Clone, Serialize)]
pub struct PickDatabase {
    pub name: String,
    pub size_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PickTable {
    pub schema: String,
    pub name: String,
    /// `table`, `view` or `materialized view`.
    pub kind: &'static str,
    pub rows: Option<u64>,
    /// Over `BIG_TABLE_ROWS`: an agent only reads it with an indexed WHERE.
    pub big: bool,
    /// For marking columns sensitive (`mask`).
    pub columns: Vec<PickColumn>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PickColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
}

#[derive(Default)]
pub struct Picker {
    store: Mutex<Store>,
}

impl Picker {
    /// Closes every session the picker opened. Edit access calls it when it
    /// closes, so browsing a connection doesn't hold a session on each of its
    /// databases until the app quits.
    pub async fn close(&self) {
        *self.store.lock().await = Store::default();
    }

    pub async fn databases(&self, id: &str) -> Result<Vec<PickDatabase>, String> {
        let config = AppConfig::load().map_err(|e| e.to_string())?;
        let target = any(&config, id, None)?;
        let mut store = self.store.lock().await;
        let mut list: Vec<PickDatabase> = store
            .list_databases(&target)
            .await?
            .into_iter()
            .map(|(name, size_bytes)| PickDatabase { name, size_bytes })
            .collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(list)
    }

    /// Tables, views and materialized views; partitions go with their parent.
    pub async fn tables(
        &self,
        id: &str,
        database: &str,
        refresh: bool,
    ) -> Result<Vec<PickTable>, String> {
        let config = AppConfig::load().map_err(|e| e.to_string())?;
        let target = any(&config, id, Some(database))?;
        let mut store = self.store.lock().await;
        let cached = store.catalog(&target, refresh).await?;
        let mut list: Vec<PickTable> = cached
            .catalog
            .databases
            .iter()
            .flat_map(|db| db.schemas.iter())
            .flat_map(|s| s.tables.iter().map(move |t| (s.name.as_str(), t)))
            .filter(|(_, t)| t.partition_of.is_none())
            .map(|(schema, t)| {
                let rows = crate::rows_estimate(&t.row_estimate);
                PickTable {
                    schema: schema.to_string(),
                    name: t.name.clone(),
                    kind: match t.kind {
                        TableKind::Table => "table",
                        TableKind::View => "view",
                        TableKind::MaterializedView => "materialized view",
                    },
                    rows,
                    big: rows.is_some_and(|n| n > BIG_TABLE_ROWS),
                    columns: t
                        .columns
                        .iter()
                        .map(|c| PickColumn {
                            name: c.name.clone(),
                            type_name: c.type_name.clone(),
                        })
                        .collect(),
                }
            })
            .collect();
        list.sort_by(|a, b| (&a.schema, &a.name).cmp(&(&b.schema, &b.name)));
        Ok(list)
    }
}
