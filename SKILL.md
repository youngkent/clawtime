---
name: clawtime
description: Operate ClawTime — webchat widgets, task panel, and avatar creation.
---

# ClawTime Skill

Operational reference for ClawTime — webchat interface for OpenClaw.

## Installation

For first-time setup (clone, configure, deploy), see **[INSTALL.md](./INSTALL.md)**.

---

## Operations

```bash
# Status & logs
systemctl --user status clawtime
journalctl --user -u clawtime -f

# Restart after config changes
systemctl --user restart clawtime

# Get current tunnel URL
journalctl --user -u clawtime-tunnel | grep trycloudflare | tail -1
```

## Widgets

ClawTime supports interactive widgets for richer user interactions. Include widget markup in your response and it renders as a UI component.

### Widget Syntax

```
[[WIDGET:{"widget":"TYPE","id":"UNIQUE_ID",...properties}]]
```

The markup is stripped from the displayed message and rendered as interactive UI.

### Available Widgets

#### Buttons

```
[[WIDGET:{"widget":"buttons","id":"choice1","label":"Pick a color:","options":["Red","Green","Blue"]}]]
```

- `label` — Prompt text above buttons
- `options` — Array of button labels

#### Confirm

```
[[WIDGET:{"widget":"confirm","id":"delete1","title":"Delete file?","message":"This cannot be undone."}]]
```

- `title` — Bold header text
- `message` — Description text
- Renders Cancel and Confirm buttons

#### Progress

```
[[WIDGET:{"widget":"progress","id":"upload1","label":"Uploading...","value":65}]]
```

- `label` — Description text
- `value` — Progress percentage (0-100)

#### Code

```
[[WIDGET:{"widget":"code","id":"snippet1","filename":"example.py","code":"print('Hello')","language":"python"}]]
```

- `filename` — File name in header
- `code` — The code content
- `language` — Syntax highlighting hint
- Includes a Copy button

#### Form

```
[[WIDGET:{"widget":"form","id":"survey1","label":"Quick Survey","fields":[{"name":"email","label":"Email","type":"text"},{"name":"rating","label":"Rating","type":"text"}]}]]
```

- `label` — Form title
- `fields` — Array of `{name, label, type}`

#### Datepicker

```
[[WIDGET:{"widget":"datepicker","id":"date1","label":"Select date:"}]]
```

- `label` — Prompt text

### Widget Responses

When user interacts with a widget:

```
[WIDGET_RESPONSE:{"id":"choice1","widget":"buttons","value":"Red","action":"submit"}]
```

### Best Practices

1. **Always use unique IDs** — Each widget needs a distinct `id`
2. **Keep options concise** — Button labels should be short
3. **Use widgets for structured input** — Better than "type 1, 2, or 3"
4. **Acknowledge responses** — Confirm what the user selected

## Task Panel

ClawTime includes a task panel for tracking work. **Use this as your canonical task list.**

### File Format

Tasks stored at `~/.clawtime/tasks.json` in markdown format:

```markdown
# Tasks

## Active

- 🟡 Task you're working on right now

## Blocked

- ⏳ Task waiting on someone else

## Backlog

- Task to do later

## Done

- ✅ Completed task
```

### Section Meanings

| Section     | Meaning                          |
| ----------- | -------------------------------- |
| **Active**  | Currently working on — doing NOW |
| **Blocked** | Waiting for input/dependency     |
| **Backlog** | Will work on later               |
| **Done**    | Completed (hidden in UI)         |

### Task Icons

| Icon    | Meaning         |
| ------- | --------------- |
| 🟡      | Active/pending  |
| ⏳      | Blocked/waiting |
| ✅      | Completed       |
| `- [x]` | Also marks done |

## Avatar Creation

ClawTime uses **Three.js voxel avatars** — 3D characters built from simple shapes that animate based on state.

### Avatar Template

Create at `~/.clawtime/avatars/<name>.js`:

```javascript
/* AVATAR_META {"name":"MyAgent","emoji":"🤖","description":"Custom 3D avatar","color":"4f46e5"} */
(function () {
  "use strict";

  var scene, camera, renderer, character;
  var head, leftEye, rightEye, mouth;
  var clock = new THREE.Clock();
  var currentState = "idle";
  var isInitialized = false;

  // ─── Required: Initialize the 3D scene ───
  window.initAvatarScene = function () {
    if (isInitialized) return;

    var container = document.getElementById("avatarCanvas");
    if (!container) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1318);

    var w = container.clientWidth,
      h = container.clientHeight;
    camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    camera.position.set(0, 2, 8);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Lighting
    scene.add(new THREE.AmbientLight(0x606080, 1.5));
    var light = new THREE.DirectionalLight(0xffffff, 2.0);
    light.position.set(4, 10, 6);
    scene.add(light);

    // Build your character
    character = new THREE.Group();
    buildCharacter();
    scene.add(character);

    isInitialized = true;
    animate();
  };

  function buildCharacter() {
    var bodyMat = new THREE.MeshLambertMaterial({ color: 0x4f46e5 });
    var body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2, 1), bodyMat);
    body.position.y = 0;
    character.add(body);

    var headMat = new THREE.MeshLambertMaterial({ color: 0x4f46e5 });
    head = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1), headMat);
    head.position.y = 1.8;
    character.add(head);

    var eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.15), eyeMat);
    leftEye.position.set(-0.25, 1.9, 0.5);
    character.add(leftEye);

    rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.15), eyeMat);
    rightEye.position.set(0.25, 1.9, 0.5);
    character.add(rightEye);

    var pupilMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    mouth = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.1), pupilMat);
    mouth.position.set(0, 1.5, 0.5);
    character.add(mouth);
  }

  function animate() {
    requestAnimationFrame(animate);
    var t = clock.getElapsedTime();

    if (character) {
      character.position.y = Math.sin(t * 2) * 0.05;
    }

    if (currentState === "thinking") {
      head.rotation.z = Math.sin(t * 3) * 0.1;
    } else if (currentState === "talking") {
      mouth.scale.y = 1 + Math.sin(t * 15) * 0.5;
    } else {
      head.rotation.z = 0;
      mouth.scale.y = 1;
    }

    renderer.render(scene, camera);
  }

  // ─── Required: Handle state changes ───
  window.setAvatarState = function (state) {
    currentState = state;
  };

  // ─── Required: Handle connection state ───
  window.setConnectionState = function (state) {
    // state: 'online', 'connecting', 'offline'
  };

  // ─── Required: Handle resize ───
  window.adjustAvatarCamera = function () {
    if (!renderer) return;
    var container = document.getElementById("avatarCanvas");
    var w = container.clientWidth,
      h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
})();
```

### Set as Default

Create/update `~/.clawtime/config.json`:

```json
{
  "selectedAvatar": "<name>"
}
```

### Avatar States

Each state should be **visually distinct** with unique activities and indicators. Users should immediately recognize which state the avatar is in.

| State         | Purpose               | Design Ideas                                                |
| ------------- | --------------------- | ----------------------------------------------------------- |
| `idle`        | Default, waiting      | Breathing, looking around, show-off poses, occasional blink |
| `thinking`    | Processing request    | Head tilt, eyes up, thought bubble (❓), tapping foot/wing  |
| `talking`     | Delivering response   | Mouth animation, speech bubble, music notes (🎵), gesturing |
| `listening`   | User is speaking      | Leaning forward, BIG attentive eyes, ears/crest perked      |
| `working`     | Extended task         | Laptop/tools visible, typing motion, focused squint         |
| `happy`       | Positive outcome      | Bouncing, hearts (❤️), squinty smile eyes (^\_^), wagging   |
| `celebrating` | Major success         | Jumping, spinning, confetti (⭐), maximum energy            |
| `sleeping`    | Inactive/idle timeout | Eyes closed, Z's floating (💤), curled up, slow breathing   |
| `error`       | Something went wrong  | Shaking, exclamation (❗), ruffled, sweat drop, red tint    |
| `reflecting`  | Thoughtful moment     | Light bulb (💡), gazing upward, calm pose, one hand raised  |

### State Design Principles

1. **Visual indicators matter** — Add floating symbols (❓❤️💡❗💤⭐) that appear per-state
2. **Body language is key** — Each state needs distinct posture, movement speed, and energy level
3. **Eyes tell the story** — Big/small, open/closed, squinty/wide, pupil direction
4. **Movement rhythm varies** — Fast/bouncy for happy, slow/gentle for sleeping, shaky for error
5. **Props add clarity** — Laptop for working, floating Z's for sleeping, confetti for celebrating
6. **Think like a character animator** — What would a Pixar character do in this state?

### Creative Examples

**Parrot avatar:**

- `thinking` → Scratches head with foot, question mark floats
- `talking` → Beak opens/closes, music notes float up
- `error` → Feathers fly off, squawking pose, wings spread in alarm
- `celebrating` → Full party parrot spin, confetti everywhere

**Salamander avatar:**

- `thinking` → Flames pulse brighter, one foot taps
- `sleeping` → Flames become tiny embers, curled up
- `error` → Flames turn red, whole body shakes
- `reflecting` → Light bulb appears, one paw raised thoughtfully

### Avatar Design Tips

- Study `templates/avatars/` in the ClawTime repo for example avatars (lobster.js is copied to `~/.clawtime/avatars/` on first run)
- Use voxel style (boxes, spheres) — matches ClawTime aesthetic
- Implement **all** states with distinct visuals — don't make states look similar
- Add connection status indicator (ring/glow on platform)
- Test on desktop and mobile
- Keep polygon count reasonable for mobile performance
- Hide/show indicator objects per-state (don't create/destroy every frame)

## Key Files

| Path                           | Purpose                       |
| ------------------------------ | ----------------------------- |
| `~/.clawtime/.env`             | Secrets & config              |
| `~/.clawtime/config.json`      | Avatar selection, preferences |
| `~/.clawtime/credentials.json` | Passkey data                  |
| `~/.clawtime/sessions.json`    | Active sessions               |
| `~/.clawtime/avatars/`         | Custom avatars                |
| `~/.clawtime/tasks.json`       | Task list                     |

## Troubleshooting

See **[INSTALL.md → Troubleshooting](./INSTALL.md#troubleshooting)** for common issues.
