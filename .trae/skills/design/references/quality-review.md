# Design Quality Review Process

> Source: [impeccable](https://github.com/pbakaus/impeccable)  |  Anti-pattern detection + Finish Review

## Design Review Checklist

### 1. Persistence (PRODUCT.md / DESIGN.md)
- DESIGN.md exists and matches the built artifact
- For extensions: does the design reference predate this build?

### 2. Fidelity (against approved comp)
- Topology, reading order, focal scale match
- Overlaps and z-order correct
- Density and signature geometry preserved
- Name every drift: intentional or defect

### 3. Ceiling (against QUALITY BAR)
- Native devices fully utilized
- Frame, depth, lettering treatment checked
- Ornament density appropriate
- Motion/transitions applied

### 4. Contract Verification
- FORM carries seed key from concept roll
- Each of 5 blocks keeps its promise
- Memory test: first viewport is recognizable

### 5. Truth
- Demo data labeled synthetic
- No invented commercial claims
- Unanswered claims → marked placeholders
- Image-native regions → real assets (not gradients)

## Output Format

```
persistence: [pass/fail + specifics]
fidelity: [drift list or "faithful"]
ceiling: [unused devices or "reached"]
material_fixes: [ordered, max 8, one line each]
keep: [one-line preservation directive]
```

## Key Principles
- REVIEW ONLY — never edit artifacts directly
- Judge by file content, not browser rendering
- Name missing inputs first before reviewing
- Anti-pattern detection is for the build phase, not review
