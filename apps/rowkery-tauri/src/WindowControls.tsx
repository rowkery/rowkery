import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMacPlatform } from "./platform";
import { nativeDecorations } from "./windowChrome";

/**
 * Top-left corner of the window, over the sidebar's top row. It drags the
 * window; macOS draws its native traffic lights here (positioned by
 * `trafficLightPosition` in tauri.macos.conf.json), elsewhere we draw ours,
 * unless the system title bar has them (`native_decorations`, windowChrome.ts):
 * then there is no corner at all.
 */
export function WindowControls() {
  const win = () => getCurrentWindow();
  if (nativeDecorations()) return null;
  return (
    <div data-testid="traffic-zone" className="traffic-zone" data-tauri-drag-region>
      {!isMacPlatform() && (
        <div data-testid="traffic" className="traffic">
          <button
            type="button"
            data-testid="traffic-btn"
            className="traffic-btn close"
            data-action="close"
            aria-label="Close"
            onClick={() => void win().close()}
          />
          <button
            type="button"
            data-testid="traffic-btn"
            className="traffic-btn minimize"
            data-action="minimize"
            aria-label="Minimize"
            onClick={() => void win().minimize()}
          />
          <button
            type="button"
            data-testid="traffic-btn"
            className="traffic-btn maximize"
            data-action="maximize"
            aria-label="Maximize"
            onClick={() => void win().toggleMaximize()}
          />
        </div>
      )}
    </div>
  );
}
