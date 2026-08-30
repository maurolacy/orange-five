# Pool Ball Color Restoration

A Chrome extension that restores **classic** pool ball colours on live and VOD streams that use the newer "TV-optimised" palette.

## The orange five

For decades, the 5-ball has been orange. It is one of the most recognisable balls on the table — bright, warm, unmistakable. Every pool player and fan carries that colour in their muscle memory. You see orange, you know it's the five.

In 2018, [Matchroom](https://matchroompool.com/) asked Aramith (SALUC) to redesign the ball set for better contrast on small screens and digital streams. The result was the **Tournament Black** set, now standard at Matchroom events such as the [Mosconi Cup](https://www.mosconi-cup.com/) and the [US Open Pool Championship](https://matchroompool.com/us-open-pool-championship/), and streamed on [WNT TV](https://www.wnttv.com/) (the [World Nineball Tour](https://worldnineballtour.com/) platform). Among the changes: the **orange 5 became purple**.

Of all the palette tweaks, this one is the most hated. Orange was iconic — deeply wired into the muscle memory of anyone who has ever watched or played pool. And replacing it with purple made things worse, not better. Purple was the **traditional colour of the 4-ball**. The 4 had already moved to pink in Aramith's earlier Tournament TV set, and that change was broadly accepted. But when the Tournament Black came along, rather than put purple back on the 4 where it belonged, they put it on the 5. Aramith [acknowledges](https://aramith.com/story-behind-aramith-tournament-black-colours/) that using purple for the 4 "would have been closer to tradition" — but since the pink 4 had become the standard on TV, they felt they couldn't. So they gave the five the four's old colour instead.

Fans watching a stream now see a purple ball and instinctively think "four" — only to be wrong. The change that was supposed to reduce confusion on screen ended up creating a new kind of it.

Not everyone in the industry agrees with this direction. [Predator](https://predatorcues.com/)'s **Arcos II** ball set — ironically also manufactured by Aramith — is used at [EPBF](https://www.epbf.com/) and [Pro Billiard Series](https://probilliardseries.com/) events and keeps the **orange 5**. Proof that you can optimise for video without throwing away decades of tradition.

This extension is a client-side workaround for the rest of us. It does **not** change the stream or the balls at the venue; it remaps colours in the browser so *your* view can look classic again.

### What it remaps

| Stream colour | Restored to | Ball | Default |
|---------------|-------------|------|---------|
| Purple | **Orange** | 5 | On |
| Pink | **Purple** | 4 | On |
| Cyan | **Blue** | 2 | Off |

## How it works

1. Finds the main `<video>` inside players such as Mux (including Shadow DOM).
2. Draws each frame to a WebGL canvas overlaid on the video.
3. A small fragment shader remaps selected hue ranges (violet → orange, pink → purple, cyan → blue).
4. Everything is tunable from the popup; settings are stored with `chrome.storage`.

It is a **best-effort global remap**: pixels matching those hues anywhere in the frame can be affected, not only balls. That keeps the approach simple and fast. Independent toggles let you disable remaps that spill onto nearby colours (e.g. pink → purple onto reds, or cyan → blue onto grey cloth).

## Install (unpacked)

1. Clone this repo (or download a release zip).
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. **Load unpacked** → select this project folder.
5. Pin **Pool Color Restorer** from the toolbar if you like.

Works on Chromium-based browsers that support Manifest V3 extensions (Chrome, Edge, Brave, etc.).

## Usage

Open the extension popup:

| Control | Role |
|---------|------|
| **On** | Master switch for the whole pipeline |
| **Purple → orange (5)** | The main fix; on by default |
| **Pink → purple (4)** | Restores a more classic 4; can spill onto reds — disable if needed |
| **Cyan → blue (2)** | Optional; off by default (can tint grey cloth) |
| **Saturation** | How vivid the remapped colour is |
| **Selectivity** | Higher = stricter detection, less spill onto nearby hues |

Toggle **On** off anytime to compare with the original stream colours.

Active on pages whose host contains `wnttv`, `youtube`, or `matchroom`.

## Background

The palette changes are **not** a streaming bug or colour-grading artefact. They are an [intentional redesign by Aramith](https://aramith.com/story-behind-aramith-tournament-black-colours/), developed with Matchroom for televised and digitally streamed pool. The stated rationale mentions improving contrast on small screens, particularly between orange and red, and between dark blue and dark green.

Whether those improvements justify losing the orange five is, of course, a matter of opinion.

## Limitations

- Not ball-aware: similar colours in the background, UI, or cloth can shift.
- Look varies by event and camera; you may need to tweak saturation and selectivity.
- Requires WebGL; the overlay needs access to the video texture (normal for same-origin / blob stream playback).
- Only helps *viewers* — it does not change what players see at the table.

## Privacy

No analytics, no accounts, no network calls from the extension itself. Only `storage` is used to remember your settings.

## License

MIT
