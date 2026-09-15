# Product

## Register

product

## Users

Single user: the owner-operator, at a desk on a small-to-medium laptop window. They run 8+ personal AI agents (assistant, coach, creator, focuscoach, knower, pibot-dev, researcher, tax) reached mainly through Telegram. They open the dashboard (127.0.0.1:7860) to do agent surgery: create and wire agents, edit manifests and personas, manage heartbeats/schedules, review memory, log in to model providers. They are technical, fast, and impatient with ceremony; sessions are short and frequent, often while something is broken and needs a fix now.

## Product Purpose

A control room for a personal multi-agent runtime. Success is: open, glance, act, close. Every second between intent and effect is friction. The dashboard must never get in the way of the Telegram-first workflow; it exists for the moments chat can't do (structured edits, provider auth, bulk state).

## Brand Personality

Calm expert tool. Linear/Raycast-adjacent: dense but quiet, keyboard-fast, zero ceremony, no decorative noise. Three words: precise, unobtrusive, confident.

## Anti-references

- Flashy SaaS admin: card grids everywhere, gradient dashboards, hero metrics, icon+title+text tiles.
- Enterprise config screens: tab mazes, modal-over-modal, settings that require saving "contexts" you can lose.
- Anything that scrolls the user to the top or reloads the page as a side effect of an action.

## Design Principles

1. **Preserve the operator's place.** No action may scroll, reload, or reposition the page out from under the user. Context is sacred.
2. **Actions stay where they happen.** Inline feedback over redirects; a control acknowledges itself in place.
3. **Density without noise.** Show the data; skip the chrome. Type and spacing do the hierarchy work.
4. **Explicit over clever.** Destructive or state-changing controls say so; nothing moves or appears without cause.
5. **Fast to leave, faster to return.** Deep links, stable URLs, no dead ends.

## Accessibility & Inclusion

Solid defaults: visible focus states, WCAG-AA contrast, semantic HTML, respects prefers-reduced-motion. Keyboard-operable forms.