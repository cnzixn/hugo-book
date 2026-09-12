---
title: "Example Blog Post"
date: 2025-01-15
tags: ["hugo", "theme"]
categories: ["Example"]
---

This is an example blog post demonstrating the Hugo Book blog layout.

## What This Demonstrates

Blog posts in Hugo Book support standard Hugo content features:

- **Date display**: configured via `BookDateFormat`
- **Tags and categories**: displayed as metadata
- **Pagination**: automatic when multiple posts exist
- **Prev/next navigation**: links between posts in the section

## Adding Your Own Posts

Create markdown files under `content/posts/`:


```plaintext  {filename="xxx.txt", copy="false", collapse="true"}
content/
└── posts/
    ├── _index.md
    ├── first-post.md
    └── second-post.md
```

Each post needs at minimum a `title` and `date` in frontmatter. See [Blog](/docs/content/blog/) for full documentation.


## Shortcode For Bili

{{< bili BV1cNV56VEBd >}}  

## Shortcode For Gallery

{{< gallery caption="" href="" >}}
  static\img\dst\Snipaste_2026-09-11_20-18-55.png
{{< /gallery >}}

## Markdown Alerts

Standard GitHub markdown alert syntax is also supported:

> [!TIP]
> Set `disablePathToLower = true` in your config to preserve URL casing.

> [!IMPORTANT]
> The `unsafe = true` goldmark setting is required for Mermaid and KaTeX shortcodes.

> [!WARNING]
> Service worker support is experimental and may change in future releases.

> [!CAUTION]
> Enabling `BookPortableLinks = 'error'` will fail the build if any markdown link targets are missing.


