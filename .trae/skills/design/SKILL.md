---
name: "design"
description: "Unified design system skill for InfraX — combines DESIGN.md templates (awesome-design-md), creative quality enforcement (taste-skill), and design review process (impeccable). Invoke for UI/UX work, page design, component building, or design quality review."
---

# InfraX Design System Skill

Combines three best-in-class approaches:
- **DESIGN.md templates** (from 73 brands via awesome-design-md)
- **Creative enforcement** (anti-pattern bans, AIDA, GSAP via taste-skill)
- **Quality review** (anti-pattern detection via impeccable)

## Decision Tree

```
你要做什么？
│
├─ 新建页面 / 组件 / 布局
│  → 先执行 Phase 1 (Design Plan + Randomization)
│  → 再执行 Phase 2 (Build with Rules)
│
├─ 审查已有 UI / 定设计系统
│  → 先执行 Phase 3 (Quality Review)
│  → 参考 Phase 4 (DESIGN.md 模板)
│
└─ 建立 InfraX 自己的 DESIGN.md
   → Phase 4 (模板参考)
```

---

## Phase 1: Design Plan (pre-code)

Before writing any UI code, output a `<design_plan>` block:

### 1. Python RNG Execution
Simulate randomization to break LLM repetition:
```python
import random, hashlib
seed = int(hashlib.md5(user_prompt.encode()).hexdigest()[:8], 16) % 100
random.seed(seed)
layout = random.choice(["cinematic_center", "asymmetric_overlap", "editorial_split", "full_bleed"])
accent = random.choice(["kinpaku-gold", "verdigris-patina", "neon-cyan", "electric-blue"])
font = random.choice(["Satoshi", "Cabinet Grotesk", "Outfit", "Geist"])
motion = random.sample(["scroll_pin", "scale_fade", "text_reveal", "card_stack"], 2)
print(f"layout={layout} accent={accent} font={font} motion={motion}")
```

### 2. AIDA Check
Confirm every page has:
- **A**ttention — Cinematic hero, 2-3 line H1, ultra-wide container
- **I**nterest — `grid-flow-dense` bento, zero empty cells
- **D**esire — ScrollTrigger animations (pin/scrub/reveal)
- **A**ction — High-contrast CTA footer

### 3. Hero Math Verification
- H1 container: `max-w-6xl` minimum
- Font size: `clamp(3rem, 5vw, 5.5rem)`
- Guaranteed 2-3 lines, never 4+

### 4. Typography Selection
- NEVER use Inter (LLM statistical bias)
- Use font from randomization output
- Font stack: `"Satoshi", "Cabinet Grotesk", "Outfit", "Geist"`

---

## Phase 2: Build Rules (during code)

### InfraX Design Tokens

```css
:root {
  /* Colors — warm mineral dark (never pure #000) */
  --canvas:      #0B0E11;
  --surface:     #1E2329;
  --surface-alt: #2B3139;
  --border:      #2B3139;

  /* Brand accent — kinpaku gold (OKLCH) */
  --brand:       oklch(84% 0.19 80.46);
  --brand-hover: oklch(78% 0.12 82);

  /* Text */
  --text-primary:   #EAECEF;
  --text-secondary: #848E9C;
  --text-tertiary:  #5E6673;

  /* States */
  --success: #0ECB81;
  --error:   #F6465D;
  --warning: #F0B90B;

  /* Geometry */
  --radius-pill: 999px;
  --radius-card: 8px;
  --radius-input: 6px;
  --radius-modal: 12px;

  /* Spacing (8px grid) */
  --space-unit: 8px;
  --section-gap: 80px;
}
```

### Anti-Patterns — HARD BAN

```
NEVER:
├─ // ...  // rest of code  // TODO  bare ...
├─ 6-line wrapped H1 (use wider container)
├─ "SECTION 01" / "QUESTION 05" meta-labels
├─ Flat colors with zero motion/interactivity
├─ Pure #000 background (use warm mineral dark)
├─ Gradient backgrounds on cards/chrome
├─ emojis in code or output
├─ Left/Right layout repetition
└─ Box-shadow on buttons
```

### Layout Rules

```css
/* Page wrapper — prevent horizontal scroll */
main { overflow-x: hidden; width: 100%; max-width: 100%; }

/* Section spacing */
section + section { margin-top: var(--section-gap); }

/* Bento grid — zero gaps */
.bento { display: grid; grid-auto-flow: dense; }

/* Cards — 3 to 5 intentional cards, no empty cells */
```

### Motion Guidelines

```css
/* Hover — 150ms ease-out */
.card { transition: transform 150ms ease-out; }
.card:hover { transform: scale(1.02); }

/* Page transition — 300ms */
.page-enter { animation: fadeIn 300ms ease-in-out; }

/* Reveal — spring curve */
.reveal { animation: revealScale 600ms cubic-bezier(0.16, 1, 0.3, 1); }

/* GSAP ScrollTriggers */
scroll_pin:     pin section title, scroll gallery right
scale_fade:     images 0.8→1.0 on enter, fade to 0.2 on exit
text_reveal:    sequential word opacity 0.1→1.0 on scroll
card_stack:     cards overlap dynamically from bottom
```

### Component Patterns

**Button (Primary)**:
```html
<button class="rounded-full bg-[var(--brand)] text-[var(--canvas)] px-6 py-3 font-semibold
               hover:bg-[var(--brand-hover)] transition-colors duration-150">
```

**Card**:
```html
<div class="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6">
```

**Input**:
```html
<input class="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-3
              text-[var(--text-primary)] focus:border-[var(--brand)] focus:outline-none">
```

---

## Phase 3: Quality Review (post-code)

Apply the Finish Reviewer checklist (see [references/quality-review.md](references/quality-review.md)):

1. **Persistence** — DESIGN.md exists and matches artifact
2. **Fidelity** — Against comp: topology, reading order, focal scale
3. **Ceiling** — Against QUALITY BAR: unused devices, depth, motion
4. **Contract** — Each promise kept, first viewport passes memory test
5. **Truth** — No fake claims, real assets (not gradients)

Output format:
```
persistence: [pass/fail + specifics]
fidelity: [drift list or "faithful"]
ceiling: [unused devices or "reached"]
material_fixes: [ordered, max 8]
keep: [one-line preservation directive]
```

---

## Phase 4: DESIGN.md Templates

When creating InfraX's own DESIGN.md, reference [references/design-templates.md](references/design-templates.md) and [references/brands-index.md](references/brands-index.md).

### Relevant brands for InfraX (dark fintech/Web3)

| Brand | Pattern | Apply to InfraX |
|-------|---------|-----------------|
| **PlayStation** | Blue accent, 3-surface system, pill CTAs | Navigation + CTA shape |
| **Stripe** | Blue gradient, dense info, trust signals | Payment/transaction UI |
| **Linear** | Refined dark, subtle borders, keyboard-first | Admin dashboard |
| **Vercel** | Geometric, dark surface, accent dots | Landing/hero |
| **Uber** | Black-white duet, geometric font, pill everything | Minimal interaction pattern |

### Minimal Viable DESIGN.md for InfraX

```yaml
---
version: alpha
name: InfraX-design-system
description: Web3 infrastructure platform — warm mineral dark canvas, kinpaku gold accent, geometric precision. CTAs are solid gold pills, cards are elevated surfaces with hairline borders, and the system uses a 3-surface model (canvas/surface/elevated) with an 8px spacing grid.
colors:
  brand-gold: oklch(84% 0.19 80.46)
  brand-gold-hover: oklch(78% 0.12 82)
  canvas: "#0B0E11"
  surface: "#1E2329"
  surface-elevated: "#2B3139"
  text-primary: "#EAECEF"
  text-secondary: "#848E9C"
  text-tertiary: "#5E6673"
  border-subtle: "#2B3139"
  success: "#0ECB81"
  error: "#F6465D"
typography:
  display:
    fontFamily: "Satoshi, system-ui, sans-serif"
    fontSize: clamp(3rem, 5vw, 5.5rem)
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: -0.02em
  heading:
    fontFamily: "Satoshi, system-ui, sans-serif"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
  mono:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
spacing:
  unit: 8px
  section-gap: 80px
  card-padding: 24px
  page-margin: 24px
radius:
  button: 999px
  card: 8px
  input: 6px
  modal: 12px
decisions:
  - "All CTAs are solid gold pills on dark canvas"
  - "Cards use 8px radius with hairline border and dark surface bg"
  - "Inputs use 6px radius with gold focus ring"
  - "Page background is warm mineral dark (#0B0E11), never pure #000"
  - "Success is green-teal (#0ECB81), error is soft red (#F6465D)"
  - "Monospace font for all addresses, hashes, and code"
  - "No gradients on chrome, no box-shadows on buttons"
  - "Imagery over decoration for hero sections"
do-not:
  - "Never use pure black (#000) as background"
  - "Never use more than 2 font families (Satoshi + Inter + JetBrains Mono)"
  - "Never use gradient card backgrounds"
  - "Never use box-shadow on primary buttons"
  - "Never place text on images without dark overlay"
---

# InfraX Design System
(Full narrative description...)
```

---

## Quick Reference

| Need | Do This |
|------|---------|
| New page | Run Phase 1 (Design Plan) → Phase 2 (Build) |
| Review UI | Run Phase 3 (Quality Review) |
| Define system | Use Phase 4 (DESIGN.md template) |
| Component design | Follow "Component Patterns" in Phase 2 |
| Color decision | Use OKLCH ramp, never raw hex without context |
| Typography | Satoshi headings, Inter body, JetBrains mono for code |
| Spacing | Always multiples of 8px |

## Reference Files

- [references/design-templates.md](references/design-templates.md) — Full DESIGN.md template with examples
- [references/quality-review.md](references/quality-review.md) — Finish Reviewer checklist
- [references/creative-enforcement.md](references/creative-enforcement.md) — Anti-patterns + AIDA + GSAP
- [references/brands-index.md](references/brands-index.md) — 18 curated brand DESIGN.md profiles
- Full source: `/tmp/awesome-design-md/design-md/` — 73 brand DESIGN.md files
- Full source: `/tmp/impeccable/` — Design anti-pattern detection engine
- Full source: `/tmp/taste-skill/` — Creative UI enforcement rules
