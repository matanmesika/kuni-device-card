# Kuni Device Card

A Home Assistant dashboard card for the **Kuni** scent diffuser, built on the
[Kuni integration](https://github.com/taltaub22/Kuni-HomeAssistant).

- **Device header** – the diffuser, its name, on/off state, active scent and a live timer countdown, plus a large power button.
- **My scents** – one tile per cartridge with a ring showing how much is left (green, amber under 50%, red under 20%). Tap a tile to switch to that scent.
- **Intensity** – the seven device levels as tap targets.
- **Timer** – 30 min, 1 h, 2 h, 4 h or no timer (uses the `kuni.set_timer` service).
- Hebrew (RTL) and English, light and dark themes, phone-sized touch targets.

Entities are found from the device registry by their unique IDs, so renaming them does not break the card.

## Install
HACS → Frontend → ⋮ → Custom repositories → add this repo as **Dashboard**, install, then add the card:

```yaml
type: custom:kuni-device-card
```

Manual: copy `dist/kuni-device-card.js` to `/config/www/kuni-device-card/` and add
`/local/kuni-device-card/kuni-device-card.js` as a JavaScript module resource.

## Options
| Option | Description |
| --- | --- |
| `device_id` | HA device ID. Needed only when you have more than one Kuni. |
| `name` | Name shown in the header (default: device name). |
| `language` | `he` or `en` (default: Home Assistant language). |
| `image` | Your own device photo, e.g. `/local/kuni-device-card/kuni.webp` (transparent background works best). Without it a simple drawing is shown. |
| `scent_colors` | Colour per scent name, e.g. `{Soft: "#e58fb4"}`. Used for the ring, the active tile and the steady glow around the device while it runs. |

## Tests
`node --test tests/test_kuni_card.cjs`
