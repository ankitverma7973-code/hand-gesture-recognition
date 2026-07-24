# GestureLab — Real-Time Hand Gesture Recognition

A production-ready, full-stack computer vision web app that recognizes hand
gestures in real time using **Python, OpenCV, MediaPipe, and Flask**, with a
polished glassmorphism / HUD-styled front end.

![status](https://img.shields.io/badge/status-active-00d9a6) ![python](https://img.shields.io/badge/python-3.9%2B-7c5cff) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

## ✨ Features

- **Live webcam detection** — start/stop the camera from the browser; frames
  are captured server-side with OpenCV and streamed back as an MJPEG feed.
- **21-point hand landmark tracking** via MediaPipe Hands, rendered as a
  custom HUD-style skeleton overlay (glowing joints + connecting rails).
- **Two-hand support** — tracks both hands simultaneously, each labeled
  Left/Right with its own gesture, confidence and finger count, plus fun
  two-hand **combo gestures** (Double Thumbs Up, High Ten, Double Fist Bump,
  Double Peace, Double Rock On, Double OK).
- **12 recognized gestures**: Open Palm, Fist, One Finger, Two Fingers
  (Peace), Three Fingers, Four Fingers, Five Fingers, Thumbs Up,
  Thumbs Down, OK Sign, Rock On 🤘, and Call Me 🤙.
- **Floating info card** with detected gesture name(s), confidence score,
  hands detected, and live FPS.
- **Session dashboard**: total frames processed, total gestures detected,
  current gesture, and detection accuracy.
- **Gesture history panel** — the last 10 detected gestures/combos with
  timestamps and confidence.
- **Air Canvas** — draw in the air with your index finger(s); **use both
  hands at once** to sketch bigger shapes together (like a heart or a
  square) — each hand gets its own pen color. Open palm (either hand)
  clears the canvas; pick a color/brush size and download your artwork
  as a PNG.
- **Gesture Control Panel** — a live demo of gestures driving a real UI: a
  gesture-controlled slideshow with play/pause, next/previous, volume, and
  favorites, all mapped to specific hand gestures.
- **Rock Paper Scissors mini-game** — play against the computer using
  Fist (Rock), Open Palm (Paper), or Two Fingers (Scissors), with a
  countdown, live scoreboard, and a **win streak tracker** — your best
  streak is saved in the browser and survives a score reset.
- **Voice announcements** — optionally have the browser speak the
  detected gesture name out loud as it changes (Web Speech API), toggled
  with the speaker button next to the camera controls.
- **Achievement badges** — 9 unlockable badges (First Steps, Gesture
  Explorer, Combo Star, Century Club, Digital Artist, RPS Rookie, and
  more) with a toast pop-up on unlock and a badge shelf on the dashboard;
  progress is saved in the browser across visits.
- **Dark / light mode**, fully responsive (desktop, tablet, mobile),
  glassmorphism UI, and smooth scroll/reveal animations.
- **Graceful error handling** when no webcam is available.

## 🗂 Project Structure

```
HandGestureRecognition/
│
├── app.py                     # Flask app, MJPEG streaming, stats API
├── requirements.txt
├── templates/
│   └── index.html             # Landing page + app UI
├── static/
│   ├── css/style.css          # Design system (glassmorphism / HUD theme)
│   ├── js/script.js           # Camera control, stats polling, UI logic
│   └── images/
├── utils/
│   ├── hand_detector.py       # MediaPipe Hands wrapper (up to 2 hands)
│   ├── gesture_classifier.py  # Geometric gesture classification + combos
│   └── air_canvas.py          # Two-pen Air Canvas drawing engine
├── screenshots/
└── README.md
```

## 🚀 Getting Started

### 1. Clone & enter the project
```bash
git clone <your-repo-url>
cd HandGestureRecognition
```

### 2. Create a virtual environment (recommended)
```bash
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
```

### 3. Install dependencies
```bash
pip install -r requirements.txt
```

### 4. Run the app
```bash
python app.py
```

Then open **http://127.0.0.1:5000** in your browser, scroll to **Live
Detection**, and click **Start Camera**. Your browser will use the machine
running the Flask server's webcam (grant OS-level camera permission if
prompted).

> **Note:** This app captures video server-side via OpenCV
> (`cv2.VideoCapture(0)`), so it's designed to be run on the same machine
> whose webcam you want to use — ideal for local development, demos, and
> kiosk-style deployments.

## 🧠 How Gesture Recognition Works

1. **Capture** — OpenCV grabs frames from the webcam at ~30 FPS.
2. **Detect** — MediaPipe Hands locates a single hand and returns 21 3D
   landmarks per frame.
3. **Classify** — `gesture_classifier.py` measures whether each finger is
   extended (tip above its PIP joint) and whether the thumb is extended
   away from the palm, then maps the resulting finger-state pattern to one
   of the 8 supported gestures. Thumbs Up is disambiguated by checking that
   the thumb tip points above the wrist while all other fingers are curled.
4. **Stream & report** — the annotated frame is JPEG-encoded and streamed
   to the browser via `multipart/x-mixed-replace`; live stats (confidence,
   FPS, finger count, history) are served from `/api/stats` and polled by
   the front end every ~650ms.

## 🛠 Tech Stack

| Layer      | Technology                              |
|------------|------------------------------------------|
| Backend    | Python, Flask                            |
| CV / ML    | OpenCV, MediaPipe Hands, NumPy           |
| Frontend   | HTML5, CSS3 (custom design system), JS   |
| Icons      | Font Awesome 6                           |
| Fonts      | Space Grotesk, Inter, JetBrains Mono     |

## 📸 Screenshots

Add your own screenshots to the `screenshots/` folder and reference them
here, e.g.:

```markdown
![Landing Page](screenshots/landing.png)
![Live Detection](screenshots/detection.png)
![Dashboard](screenshots/dashboard.png)
```

## ⚠️ Troubleshooting

- **"Unable to access webcam"** — make sure no other application is using
  the camera, and that your OS has granted camera permissions to your
  terminal / Python.
- **Low FPS** — try lowering the capture resolution in `app.py`
  (`CAP_PROP_FRAME_WIDTH` / `CAP_PROP_FRAME_HEIGHT`), or run on a machine
  with a more capable CPU (MediaPipe runs on CPU by default).
- **MediaPipe install issues** — MediaPipe requires Python 3.9–3.12 and a
  64-bit interpreter; see the [MediaPipe docs](https://developers.google.com/mediapipe)
  for platform-specific notes.

## 📄 License

MIT — free to use, modify, and showcase in your portfolio.

---

Built as a portfolio-ready showcase of real-time computer vision with a
production-quality UI.
