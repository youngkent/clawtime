# ClawTime Widget System

## Overview

Widgets are interactive UI components that agents can send to users. They enable richer interactions than plain text — buttons, forms, pickers, progress indicators, etc.

## Protocol

### Agent → ClawTime (via gateway message)

```json
{
  "type": "widget",
  "id": "unique-widget-id",
  "widget": "widget-type",
  "data": { /* widget-specific */ },
  "inline": false
}
```

- `id`: Unique identifier for this widget instance
- `widget`: Widget type (see below)
- `data`: Widget-specific configuration
- `inline`: If true, render inline in message bubble. If false, render as standalone card.

### ClawTime → Agent (user interaction)

```json
{
  "type": "widget_response",
  "id": "unique-widget-id",
  "widget": "widget-type",
  "value": /* widget-specific response */,
  "action": "submit" | "cancel" | "dismiss"
}
```

---

## Widget Types

### 1. `buttons` — Quick Reply Buttons

Horizontal/vertical button group for quick selection.

**Data:**
```json
{
  "prompt": "What would you like?",        // optional header text
  "options": ["Coffee", "Tea", "Water"],   // simple strings
  // OR rich options:
  "options": [
    { "label": "☕ Coffee", "value": "coffee" },
    { "label": "🍵 Tea", "value": "tea", "style": "primary" },
    { "label": "Cancel", "value": null, "style": "secondary" }
  ],
  "layout": "horizontal" | "vertical",     // default: horizontal
  "multiSelect": false                      // allow multiple selections
}
```

**Response:**
```json
{ "value": "coffee" }
// or for multiSelect:
{ "value": ["coffee", "tea"] }
```

---

### 2. `confirm` — Confirmation Dialog

Yes/No or custom confirm/cancel actions.

**Data:**
```json
{
  "title": "Delete file?",
  "message": "This will permanently delete config.json",
  "confirmLabel": "Delete",           // default: "Confirm"
  "cancelLabel": "Keep",              // default: "Cancel"
  "confirmStyle": "danger" | "primary", // default: primary
  "destructive": true                  // iOS-style destructive action
}
```

**Response:**
```json
{ "value": true }   // confirmed
{ "value": false }  // cancelled
```

---

### 3. `progress` — Progress Bar

Shows task progress with optional status text.

**Data:**
```json
{
  "label": "Uploading files...",
  "percent": 45,                    // 0-100, or null for indeterminate
  "status": "3 of 7 files",         // optional status text
  "showPercent": true,              // show percentage number
  "cancelable": true                // show cancel button
}
```

**Update:** Agent sends new widget message with same `id` to update progress.

**Response (if cancelled):**
```json
{ "action": "cancel" }
```

---

### 4. `code` — Code Block with Actions

Code display with copy button, syntax highlighting, and optional run button.

**Data:**
```json
{
  "code": "console.log('hello');",
  "language": "javascript",         // for syntax highlighting
  "filename": "example.js",         // optional filename header
  "showCopy": true,                 // show copy button (default: true)
  "showRun": false,                 // show run button
  "wrap": true                      // wrap long lines
}
```

**Response:**
```json
{ "action": "copy" }
{ "action": "run" }
```

---

### 5. `form` — Multi-field Form

Collect multiple inputs at once.

**Data:**
```json
{
  "title": "Create Event",
  "fields": [
    { "name": "title", "type": "text", "label": "Event Title", "required": true },
    { "name": "date", "type": "date", "label": "Date" },
    { "name": "time", "type": "time", "label": "Time" },
    { "name": "location", "type": "text", "label": "Location", "placeholder": "Optional" },
    { "name": "notify", "type": "checkbox", "label": "Send me a reminder" },
    { "name": "priority", "type": "select", "label": "Priority", 
      "options": ["Low", "Medium", "High"] }
  ],
  "submitLabel": "Create",
  "cancelLabel": "Cancel"
}
```

**Field types:** `text`, `textarea`, `number`, `email`, `tel`, `date`, `time`, `datetime`, `select`, `checkbox`, `radio`, `range`

**Response:**
```json
{
  "value": {
    "title": "Team Meeting",
    "date": "2026-02-15",
    "time": "14:00",
    "location": "Room 3",
    "notify": true,
    "priority": "Medium"
  }
}
```

---

### 6. `tasks` — Interactive Task List

Checkbox list with add/remove capabilities.

**Data:**
```json
{
  "title": "Shopping List",
  "items": [
    { "id": "1", "text": "Buy milk", "done": false },
    { "id": "2", "text": "Call dentist", "done": true },
    { "id": "3", "text": "Fix bug #123", "done": false }
  ],
  "allowAdd": true,                 // show add item input
  "allowRemove": true,              // show remove buttons
  "allowReorder": false             // drag to reorder
}
```

**Response (on any change):**
```json
{
  "value": {
    "items": [
      { "id": "1", "text": "Buy milk", "done": true },
      { "id": "2", "text": "Call dentist", "done": true },
      { "id": "3", "text": "Fix bug #123", "done": false },
      { "id": "4", "text": "New item", "done": false }
    ],
    "action": "toggle",            // toggle, add, remove, reorder
    "itemId": "1"
  }
}
```

---

### 7. `carousel` — Image/Card Carousel

Swipeable gallery of images or cards.

**Data:**
```json
{
  "items": [
    { "type": "image", "url": "/media/img1.jpg", "caption": "Beach sunset" },
    { "type": "image", "url": "/media/img2.jpg", "caption": "Mountain view" },
    { "type": "card", "title": "Option A", "description": "...", "image": "..." }
  ],
  "showDots": true,                // pagination dots
  "showArrows": true,              // prev/next arrows
  "autoPlay": false,               // auto-advance
  "selectable": true               // can select an item
}
```

**Response (if selectable):**
```json
{ "value": { "index": 2, "item": {...} } }
```

---

### 8. `datepicker` — Date/Time Picker

Native date/time selection.

**Data:**
```json
{
  "label": "Select a date",
  "type": "date" | "time" | "datetime",
  "value": "2026-02-15",           // initial value (ISO format)
  "min": "2026-02-01",             // minimum selectable
  "max": "2026-12-31",             // maximum selectable
  "required": true
}
```

**Response:**
```json
{ "value": "2026-02-15" }          // ISO format
{ "value": "2026-02-15T14:30:00" } // for datetime
```

---

### 9. `poll` — Voting/Poll

Single or multi-choice poll with optional live results.

**Data:**
```json
{
  "question": "Where should we eat?",
  "options": [
    { "id": "a", "text": "Pizza Place", "votes": 3 },
    { "id": "b", "text": "Sushi Bar", "votes": 5 },
    { "id": "c", "text": "Tacos", "votes": 2 }
  ],
  "multiSelect": false,            // allow multiple votes
  "showResults": true,             // show vote counts
  "showVoters": false,             // show who voted for what
  "allowChange": true,             // can change vote
  "myVote": "b"                    // current user's vote (if any)
}
```

**Response:**
```json
{ "value": "a" }
// or for multiSelect:
{ "value": ["a", "c"] }
```

---

### 10. `rating` — Star/Emoji Rating

Quick rating input.

**Data:**
```json
{
  "label": "How was your experience?",
  "type": "stars" | "emojis" | "numbers",
  "max": 5,                        // number of options
  "value": null,                   // current value
  "emojis": ["😢", "😕", "😐", "🙂", "😍"]  // custom emojis (if type=emojis)
}
```

**Response:**
```json
{ "value": 4 }
```

---

### 11. `alert` — Info/Warning/Error Alert

Non-interactive notification banner.

**Data:**
```json
{
  "type": "info" | "success" | "warning" | "error",
  "title": "Heads up!",
  "message": "Your session will expire in 5 minutes",
  "dismissable": true,             // show X button
  "autoHide": 5000                 // auto-dismiss after ms (0 = never)
}
```

**Response (if dismissed):**
```json
{ "action": "dismiss" }
```

---

### 12. `typing` — Typing/Thinking Indicator

Custom status indicator (replaces standard typing animation).

**Data:**
```json
{
  "status": "Searching the web...",
  "icon": "🔍",                    // optional emoji/icon
  "progress": null                 // optional 0-100 for progress bar
}
```

No response — display only.

---

## Inline vs Standalone

- `inline: true` — Widget renders inside a message bubble, flows with chat
- `inline: false` (default) — Widget renders as a full-width card between messages

---

## Widget Lifecycle

1. **Create**: Agent sends `type: widget` message
2. **Update**: Agent sends new message with same `id` to update widget state
3. **Interact**: User interacts, ClawTime sends `widget_response`
4. **Complete**: Widget can auto-disable after response, or stay interactive
5. **Expire**: Optional TTL for time-sensitive widgets (polls, confirmations)

---

## Implementation Priority

### Phase 1 (Core)
1. `buttons` — Quick replies
2. `confirm` — Confirmations
3. `code` — Code with copy button
4. `progress` — Progress indicator

### Phase 2 (Forms)
5. `form` — Multi-field forms
6. `datepicker` — Date/time selection
7. `tasks` — Interactive task list

### Phase 3 (Rich)
8. `carousel` — Image gallery
9. `poll` — Voting
10. `rating` — Quick ratings
11. `alert` — Notifications
12. `typing` — Custom status

---

## Example Flow

**Agent wants confirmation before deleting:**

```
Agent → ClawTime:
{
  "type": "widget",
  "id": "confirm-delete-1",
  "widget": "confirm",
  "data": {
    "title": "Delete file?",
    "message": "This will permanently delete notes.txt",
    "confirmLabel": "Delete",
    "confirmStyle": "danger"
  }
}

User clicks "Delete"

ClawTime → Agent:
{
  "type": "widget_response",
  "id": "confirm-delete-1",
  "widget": "confirm",
  "value": true,
  "action": "submit"
}

Agent proceeds with deletion
```
