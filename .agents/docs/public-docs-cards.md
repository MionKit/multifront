# Public docs cards

How to build a card file for `publicdocs/`.
When to use a card: [publicdocs/AGENTS.md](../../publicdocs/AGENTS.md#cards).

## Card files

- Cards are HTML so a future website can embed them as they are → each card is a self-contained snippet.
- One file per card: `publicdocs/assets/src/<name>.html`, kebab-case.
- Look comes from shared palette `docs/assets/src/theme.css`: colours as CSS variables, `.canvas`, `.eyebrow`,
  `h1`, `.sub`, `.chip`.
- Use its variables. Never hard-code a new colour.
- Whole card = one root element: `<div class="canvas card-<name>">`.
- Every rule in the card's `<style>` starts with `.card-<name>` (so the snippet cannot leak styles into a page).
- No scripts, no external images, no web fonts. Shapes + arrows: HTML or inline SVG. Text stays real text.
- Width 1200px, set on the root. Height follows the content.

```html
<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../docs/assets/src/theme.css">
<style>
  .card-<name> { width: 1200px; }
  .card-<name> .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 28px; }
</style></head>
<body>
<div class="canvas card-<name>">
  <div class="eyebrow">multifront · styles</div>
  <h1>One title that says the idea</h1>
  <p class="sub">One sentence under it.</p>
  <div class="row">…</div>
</div>
</body></html>
```

## Render

- `pnpm devx docs-images <name>` → `publicdocs/assets/<name>.png`.
- Read the PNG before committing: nothing cut off, nothing overlapping, text readable at half size.
- Commit the PNG with its HTML.
