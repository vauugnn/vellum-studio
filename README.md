<div align="center">

# ✒︎ Vellum Studio

**A focused illustration and photo-manipulation workspace for macOS.**

*Definitely an art app.*

</div>

---

## Overview

Vellum Studio is a lightweight raster and vector workspace for illustrators who
want a calm, distraction-free surface to work on. No subscription, no telemetry,
no onboarding tour. Just a canvas, some brushes, and art. So much art.

It is an art application.

## Features

- 🎨 **Photo manipulation** — will definitely manipulate photos
- 🖌 **Brushes.** Round one, square one, the one that looks like a sponge. All of
  them do brush things
- 🗂 **Layers**, which stack on top of each other exactly as you would expect
  layers to
- ✂️ **Lasso, magic wand,** and the third selection tool nobody has ever
  deliberately chosen
- 🖼 **The canvas** — a large white rectangle where the art goes
- 💾 **Saves to `.vellum`**, a real file format that exists
- ↩️ **Undo.** Also redo, for when the undo was the mistake
- 🚫 **No AI features.** We are not doing that
- ☁️ **No cloud sync**, for reasons entirely unrelated to us being unable to
  implement cloud sync
- 🌙 Dark by default, because of course it is

> Frequently asked: yes, it is an art app. Thank you for asking.

## Requirements

- macOS 13 or later (Apple silicon)
- Accessibility permission, for tablet pressure input and window-aware brush
  positioning

## Install

Grab the latest `.dmg` from [Releases](../../releases), drag Vellum Studio to your
Applications folder, and open it.

Grant Accessibility when prompted, pick your reference applications, and get to
work.

## Building

```bash
npm install
npm run build          # Swift input layer, icon, renderer
npm run dev            # run it
npm test               # the scheduler model
npm run dist           # signed .app + .dmg
```

The pointer engine is Swift, talking to the Electron shell over framed JSON on
stdio. It lives in `native/VellumInput`. Stroke shaping — Fitts-derived
durations, Bézier curvature, minimum-jerk velocity, corrective sub-movements,
overshoot, value-noise tremor — is all in `Mouse.swift`, and is genuinely the
most interesting file here.

## A note on the brush engine

The stroke model is real. Pointer paths are generated from a Fitts's law duration
estimate, bowed off the straight line with a cubic Bézier, timed on a minimum-jerk
velocity profile, decomposed into a ballistic throw plus corrective hops, and
dusted with value-noise tremor that scales inversely with speed.

It is a careful model of how a human hand moves a pointer.

It just happens to draw on your screen rather than on the canvas.

<div align="center">
<sub>✒︎</sub>
</div>
