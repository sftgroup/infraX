# DESIGN.md Template Reference

> Source: [awesome-design-md](https://github.com/VoltAgent/awesome-design-md)  |  73 brands analyzed
> Curated subset relevant to InfraX (Web3/fintech dark theme)

---

## Structure Pattern

```yaml
---
version: alpha
name: ProjectName-design-analysis
description: One-paragraph essence — mood, material, motion, magic.
colors:
  primary: "#hex"       # main CTAs, links, active states
  on-primary: "#hex"    # text on primary
  ink: "#hex"           # darkest text
  body: "#hex"          # body copy
  mute: "#hex"          # tertiary text
  canvas: "#hex"        # page background
  surface: "#hex"       # card/elevated background
  hairline: "#hex"      # borders, dividers
  success: "#hex"
  warning: "#hex"
  error: "#hex"
typography:
  display-xxl: { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing }
  display-xl: ...
  body-lg: ...
  body-md: ...
  caption: {}
spacing:
  unit: 8px
  page-padding: 24px
  section-gap: 80px
  card-padding: 24px
radius:
  button: 999px    # pill
  card: 8px
  input: 6px
  modal: 12px
shadow:
  card: "0 1px 3px rgba(0,0,0,0.08)"
  elevated: "0 4px 12px rgba(0,0,0,0.12)"
  modal: "0 8px 32px rgba(0,0,0,0.24)"
motion:
  hover: 150ms ease-out
  page: 300ms ease-in-out
  reveal: 600ms cubic-bezier(0.16, 1, 0.3, 1)
breakpoints:
  sm: 640px, md: 768px, lg: 1024px, xl: 1280px
decisions:
  - "All interactive elements use border-radius: 999px"
  - "Primary CTA is always solid fill, never outline"
  - "Cards use 8px radius with subtle hairline border"
  - "Page background has warm tint, never pure #000"
  - "Success/error states use brand-aligned tones, not raw green/red"
do-not:
  - "Never use pure black (#000) as page background"
  - "Never use more than 2 font families"
  - "Never use box-shadow on buttons"
  - "Never place text directly on images without overlay"
  - "Never use gradient backgrounds for cards/chrome"
---

# [Project Name] Design System

## Brand Personality
(2-3 sentences about the feeling, not features)

## Color System
| Token | Hex | Usage |
|-------|-----|-------|
| `--primary` | | CTAs, active, focus |
| `--canvas` | | Page bg |
| `--surface` | | Card bg |
| ... | | |

## Typography Scale
(6-8 levels: display-xl → caption)

## Component Patterns
- **Button**: Primary (solid pill), Secondary (outline pill), Ghost
- **Card**: 8px radius, hairline border, 24px padding
- **Input**: 6px radius, 12px padding, focus ring
- **Modal**: 12px radius, backdrop blur

## Layout Rules
- Page max-width: 1280px, centered
- Section spacing: 80px vertical gap
- Grid: 12-col, 24px gutter
- Content: 8px baseline grid

## Motion Guidelines
- Hover: 150ms ease-out
- Page transition: 300ms ease-in-out
- Reveal animation: 600ms spring
```

---

## Brand Quick-Reference

### Dark Theme (Relevant to InfraX)

| Brand | Key Pattern | Learn From |
|-------|------------|------------|
| **PlayStation** | Blue accent, black/white canvas switch, pill CTAs, SST light weight | Gaming = premium dark |
| **BMW** | Dark luxury, restrained color, massive imagery | Automotive = elegance |
| **Uber** | Black-and-white duet, geometric display font, pill everything | Minimal dark = smart |
| **Linear** | Refined dark, subtle borders, keyboard-first | SaaS dark = productive |
| **Vercel** | Geometric, dark surface, accent dots | Platform = modern |
| **Stripe** | Blue gradient, white canvas, dense information | Fintech = trust |

### Key Takeaways for InfraX

1. **Dark canvas ≠ black** — Use warm-tinted dark (#0B0E11, not #000)
2. **Single accent color** — One primary, one secondary, neutral ramp
3. **Pill CTAs (999px radius)** — Universal interactive shape
4. **8px spacing grid** — Everything aligns
5. **Light weight display font** — Airy, premium feel
6. **Imagery over decoration** — No gradient cards, no drop shadows on chrome
7. **3-surface system** — Canvas, Surface, Elevated
