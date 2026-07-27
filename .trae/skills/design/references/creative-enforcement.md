# Creative UI/UX Enforcement Rules

> Source: [taste-skill](https://github.com/Leonxlnx/taste-skill)  |  Design quality floor: AWWWARDS-level

## Anti-Patterns (HARD BAN)

```
BANNED: // ...  // rest of code  // TODO  bare ...  skeleton outputs
BANNED: 6-line wrapped headings, narrow containers
BANNED: "SECTION 01", "QUESTION 05" meta-labels
BANNED: flat colors, no motion, left/right repetition
BANNED: emojis in code/comments/output
```

## Python-Driven Randomization

Before writing UI code, simulate a Python script to break LLM repetition bias:
```python
import random
seed = len(user_prompt) % 42
random.seed(seed)
hero_layout = random.choice(["cinematic_center", "artistic_asymmetry", "editorial_split"])
font_stack = random.choice(["Satoshi", "Cabinet Grotesk", "Outfit", "Geist"])
components = random.sample(["inline_images", "horizontal_accordion", "infinite_marquee", "testimonial_carousel"], 3)
gsap = random.sample(["scroll_pinning", "image_scale_fade", "text_reveal_scrub", "card_stacking"], 2)
```

## AIDA Page Structure

Every page MUST follow this structure with massive vertical spacing:
- **A**ttention (Hero): Cinematic, ultra-wide container, 2-3 line H1 max
- **I**nterest (Bento): `grid-flow-dense`, no empty cells, 3-5 intentional cards
- **D**esire (GSAP): ScrollTrigger animations (pinning, scrubbing, reveal)
- **A**ction (Footer): High-contrast CTA

**Spacing**: `py-32 md:py-48` between sections.

## Typography Iron Rule
- H1: `max-w-5xl` or wider → MUST be 2-3 lines, NEVER 4+
- Font: `clamp(3rem, 5vw, 5.5rem)` for heading
- NEVER use Inter (statistical bias). Use Satoshi/Cabinet Grotesk/Outfit/Geist

## GSAP Motion
- Cards: `group-hover:scale-105 transition-transform duration-700 ease-out`
- Scroll pinning: `ScrollTrigger pin: true` on section title
- Image scale: `0.8 → 1.0` on scroll in, `opacity: 0.2` on scroll out
- Text reveal: opacity 0.1 → 1.0 sequential per word
- Card stacking: dynamic overlap from bottom

## Layout Bug Prevention
```html
<main className="overflow-x-hidden w-full max-w-full">
```
Always wrap page to prevent horizontal scrollbars.
