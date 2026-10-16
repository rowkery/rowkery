import type { MDXComponents } from "mdx/types";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Link from "next/link";
import { CodeBlock } from "@/components/CodeBlock";
import { Card, Cards, Env, Note, Shot, Steps } from "@/components/Blocks";
import { slug, textOf } from "@/lib/slug";

function Heading({ as: Tag, children }: { as: "h2" | "h3"; children?: ReactNode }) {
  const id = slug(textOf(children));
  return (
    <Tag id={id}>
      <a className="anchor" href={`#${id}`}>
        {children}
      </a>
    </Tag>
  );
}

/** Internal links go through Next's Link; anything with a scheme opens as a normal link. */
function A({ href = "", ...rest }: ComponentPropsWithoutRef<"a">) {
  if (/^[a-z]+:/i.test(href)) return <a href={href} {...rest} />;
  return <Link href={href} {...rest} />;
}

const components: MDXComponents = {
  h2: ({ children }) => <Heading as="h2">{children}</Heading>,
  h3: ({ children }) => <Heading as="h3">{children}</Heading>,
  a: A,
  pre: (props) => <CodeBlock {...props} />,
  table: (props) => (
    <div className="tbl">
      <table {...props} />
    </div>
  ),
  Card,
  Cards,
  Env,
  Note,
  Shot,
  Steps,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
