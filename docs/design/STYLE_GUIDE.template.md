# STYLE GUIDE (template)

Copy to `docs/design/STYLE_GUIDE.md` in a project with a UI and fill it in. When it exists, `CLAUDE.process.md` makes conformance mandatory for every UI change and `/code-review` checks UI diffs against it.

Keep it prescriptive — rules an agent can check a diff against, not aspirations.

## Principles
- [2–4 non-negotiable design principles for this product.]

## Layout & Spacing
- Spacing scale: [e.g. 4px base — 4/8/12/16/24/32/48].
- Container widths, breakpoints.
- Grid / page structure.

## Color
- Semantic tokens (background, surface, text, muted, border, primary, destructive, …) with light and dark values.
- Never hard-code hex outside the token definitions.

## Typography
- Font families + fallback stacks.
- Type scale (size / line-height / weight per role: display, heading, body, caption).

## Components
- Which component library is authoritative and how it is extended.
- Rules for buttons, forms, tables, modals, empty states, loading states, error states.
- Every data view must handle loading and error explicitly.

## Interaction & Motion
- Transition durations/easing. When motion is used and when it is not.
- Focus states, keyboard navigation.

## Accessibility
- Contrast minimums, target sizes, ARIA expectations, reduced-motion handling.

## Content & Voice
- Capitalization (sentence vs title case), tone, terminology, date/number formatting.

## Anti-patterns
- [Concrete things never to do in this UI.]
