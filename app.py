"""
app.py
------
Flask backend for the Hand Gesture Recognition app.

Routes:
    GET  /                  -> landing page (templates/index.html)
    GET  /video_feed        -> MJPEG stream with landmark overlay drawn in
    POST /api/camera/start  -> opens the webcam and starts processing
    POST /api/camera/stop   -> releases the webcam
    GET  /api/stats         -> JSON snapshot of live detection stats

    GET  /canvas_feed        -> MJPEG stream for the Air Canvas drawing mode
    POST /api/canvas/start   -> opens the webcam for Air Canvas
    POST /api/canvas/stop    -> releases the Air Canvas webcam
    POST /api/canvas/clear   -> wipes the current artwork
    POST /api/canvas/color   -> sets the active pen color
    POST /api/canvas/thickness -> sets the active pen thickness
    GET  /api/canvas/download -> downloads the current artwork as a PNG
    GET  /api/canvas/status  -> JSON snapshot of the current pen mode

All shared state is protected by a single lock since the Flask dev server
serves the stream and the stats/control endpoints on different threads.
"""

import time
import threading
from collections import deque

import io

import cv2
from flask import Flask, Response, jsonify, render_template, send_file

from utils.hand_detector import HandDetector
from utils.gesture_classifier import classify_gesture, GESTURE_LABELS, detect_combo
from utils.air_canvas import AirCanvas, PALETTE

app = Flask(__name__)

STATE_LOCK = threading.Lock()
HISTORY_MAXLEN = 10
MAX_HANDS = 2


class GestureCamera:
    """Owns the webcam capture + MediaPipe pipeline and exposes both a
    JPEG frame generator and a stats dict for the dashboard. Tracks up to
    two hands simultaneously, each with its own gesture + confidence, plus
    two-hand "combo" gestures (e.g. Double Thumbs Up)."""

    def __init__(self):
        self.cap = None
        self.detector = None
        self.active = False
        self.error = None

        self.total_frames = 0
        self.total_gestures = 0
        self.successful_detections = 0

        # Backward-compatible "primary hand" fields, always mirroring
        # hands[0] when present — older UI code can keep reading these.
        self.current_gesture = "No Hand Detected"
        self.confidence = 0.0
        self.finger_count = 0

        self.hands_data = []   # list of {handedness, gesture, confidence, finger_count}
        self.combo = None
        self.fps = 0.0
        self.history = deque(maxlen=HISTORY_MAXLEN)

        self._last_signature_for_history = None
        self._fps_timestamps = deque(maxlen=30)

    # ---------------------------------------------------------------
    # Lifecycle
    # ---------------------------------------------------------------
    def start(self):
        with STATE_LOCK:
            if self.active:
                return True, None
            self.cap = cv2.VideoCapture(0)
            if not self.cap.isOpened():
                self.cap = None
                self.error = "Unable to access webcam. Check camera permissions or connection."
                return False, self.error
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 960)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 540)
            self.detector = HandDetector(max_hands=MAX_HANDS)
            self.active = True
            self.error = None
            self.current_gesture = "No Hand Detected"
            self.hands_data = []
            self.combo = None
            self._fps_timestamps.clear()
            return True, None

    def stop(self):
        with STATE_LOCK:
            self.active = False
            if self.cap is not None:
                self.cap.release()
                self.cap = None
            if self.detector is not None:
                self.detector.close()
                self.detector = None
            self.current_gesture = "No Hand Detected"
            self.confidence = 0.0
            self.finger_count = 0
            self.hands_data = []
            self.combo = None
            self.fps = 0.0

    # ---------------------------------------------------------------
    # Frame generation
    # ---------------------------------------------------------------
    def frames(self):
        """Generator that yields MJPEG-encoded frames with the HUD
        skeleton (per hand) and stat tracking."""
        while True:
            with STATE_LOCK:
                active = self.active
                cap = self.cap
                detector = self.detector

            if not active or cap is None or detector is None:
                break

            success, frame = cap.read()
            if not success:
                with STATE_LOCK:
                    self.error = "Lost connection to webcam."
                break

            frame = cv2.flip(frame, 1)  # mirror for natural selfie-view

            hands = detector.find_hands(frame)
            per_hand_results = []
            for slot, hand in enumerate(hands):
                result = classify_gesture(hand["landmarks"], hand["score"])
                detector.draw_landmarks(frame, hand["landmarks"], hand_slot=slot)
                per_hand_results.append({
                    "handedness": hand["handedness"],
                    "gesture": result["gesture"],
                    "confidence": result["confidence"],
                    "finger_count": result["finger_count"],
                })

            self._update_stats(per_hand_results)

            ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            if not ok:
                continue

            yield (b"--frame\r\n"
                   b"Content-Type: image/jpeg\r\n\r\n" + buffer.tobytes() + b"\r\n")

    def _update_stats(self, per_hand_results):
        now = time.time()
        with STATE_LOCK:
            self.total_frames += 1
            self._fps_timestamps.append(now)
            if len(self._fps_timestamps) >= 2:
                span = self._fps_timestamps[-1] - self._fps_timestamps[0]
                if span > 0:
                    self.fps = round((len(self._fps_timestamps) - 1) / span, 1)

            self.hands_data = per_hand_results

            if per_hand_results:
                self.successful_detections += 1
                primary = per_hand_results[0]
                self.current_gesture = primary["gesture"]
                self.confidence = primary["confidence"]
                self.finger_count = primary["finger_count"]

                self.combo = None
                if len(per_hand_results) == 2:
                    self.combo = detect_combo(per_hand_results[0]["gesture"], per_hand_results[1]["gesture"])

                # Build a signature so we only log a history entry when the
                # overall hand state actually changes (avoids spamming the
                # same gesture every polling tick).
                signature = self.combo or "|".join(
                    f"{h['handedness']}:{h['gesture']}" for h in per_hand_results
                )
                has_unknown = any(h["gesture"] == GESTURE_LABELS["UNKNOWN"] for h in per_hand_results)

                if signature != self._last_signature_for_history and not has_unknown:
                    self.total_gestures += 1
                    if self.combo:
                        label = self.combo
                    elif len(per_hand_results) == 2:
                        label = f"{per_hand_results[0]['handedness']}: {per_hand_results[0]['gesture']} + {per_hand_results[1]['handedness']}: {per_hand_results[1]['gesture']}"
                    else:
                        label = f"{primary['handedness']}: {primary['gesture']}"

                    self.history.appendleft({
                        "gesture": label,
                        "confidence": round(sum(h["confidence"] for h in per_hand_results) / len(per_hand_results), 1),
                        "fingers": sum(h["finger_count"] for h in per_hand_results),
                        "time": time.strftime("%H:%M:%S"),
                    })
                    self._last_signature_for_history = signature
            else:
                self.current_gesture = "No Hand Detected"
                self.confidence = 0.0
                self.finger_count = 0
                self.combo = None
                self._last_signature_for_history = None

    def snapshot(self):
        with STATE_LOCK:
            accuracy = 0.0
            if self.total_frames > 0:
                accuracy = round((self.successful_detections / self.total_frames) * 100, 1)
            return {
                "active": self.active,
                "error": self.error,
                "total_frames": self.total_frames,
                "total_gestures": self.total_gestures,
                "current_gesture": self.current_gesture,
                "confidence": self.confidence,
                "finger_count": self.finger_count,
                "hands": self.hands_data,
                "hand_count": len(self.hands_data),
                "combo": self.combo,
                "fps": self.fps,
                "accuracy": accuracy,
                "history": list(self.history),
            }


camera = GestureCamera()


class DrawCamera:
    """Owns a separate webcam session dedicated to the Air Canvas
    drawing mode: tracks the index fingertip and paints strokes onto a
    persistent canvas layer that's composited over the live feed."""

    def __init__(self):
        self.cap = None
        self.detector = None
        self.canvas = None
        self.active = False
        self.error = None
        self.pen_mode = "idle"
        self._last_frame = None

    def start(self):
        with STATE_LOCK:
            if self.active:
                return True, None
            self.cap = cv2.VideoCapture(0)
            if not self.cap.isOpened():
                self.cap = None
                self.error = "Unable to access webcam. Check camera permissions or connection."
                return False, self.error
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 960)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 540)
            width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 960
            height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 540
            self.detector = HandDetector(max_hands=MAX_HANDS)
            if self.canvas is None:
                self.canvas = AirCanvas(width, height)
            else:
                self.canvas.resize_if_needed(width, height)
            self.active = True
            self.error = None
            self.pen_mode = "idle"
            return True, None

    def stop(self):
        with STATE_LOCK:
            self.active = False
            if self.cap is not None:
                self.cap.release()
                self.cap = None
            if self.detector is not None:
                self.detector.close()
                self.detector = None
            self.pen_mode = "idle"

    def clear(self):
        with STATE_LOCK:
            if self.canvas is not None:
                self.canvas.clear()

    def set_color(self, name):
        with STATE_LOCK:
            if self.canvas is not None:
                self.canvas.set_color(name)

    def set_thickness(self, value):
        with STATE_LOCK:
            if self.canvas is not None:
                self.canvas.set_thickness(value)

    def frames(self):
        while True:
            with STATE_LOCK:
                active = self.active
                cap = self.cap
                detector = self.detector
                canvas = self.canvas

            if not active or cap is None or detector is None or canvas is None:
                break

            success, frame = cap.read()
            if not success:
                with STATE_LOCK:
                    self.error = "Lost connection to webcam."
                break

            frame = cv2.flip(frame, 1)
            hands = detector.find_hands(frame)

            with STATE_LOCK:
                mode = canvas.update(hands)
                self.pen_mode = mode
                composited = canvas.composite(frame)
                self._last_frame = frame  # raw camera frame, without HUD skeleton

            for slot, hand in enumerate(hands):
                detector.draw_landmarks(composited, hand["landmarks"], hand_slot=slot)

            ok, buffer = cv2.imencode(".jpg", composited, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            if not ok:
                continue

            yield (b"--frame\r\n"
                   b"Content-Type: image/jpeg\r\n\r\n" + buffer.tobytes() + b"\r\n")

    def status(self):
        with STATE_LOCK:
            return {
                "active": self.active,
                "error": self.error,
                "pen_mode": self.pen_mode,
                "color": self.canvas.color_name if self.canvas else None,
                "thickness": self.canvas.thickness if self.canvas else None,
            }

    def export_png(self):
        with STATE_LOCK:
            if self.canvas is None:
                return None
            base_frame = self._last_frame if self.active else None
            return self.canvas.export_png_bytes(base_frame)


draw_camera = DrawCamera()


# ---------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/video_feed")
def video_feed():
    return Response(camera.frames(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/api/camera/start", methods=["POST"])
def start_camera():
    ok, error = camera.start()
    status = 200 if ok else 500
    return jsonify({"success": ok, "error": error}), status


@app.route("/api/camera/stop", methods=["POST"])
def stop_camera():
    camera.stop()
    return jsonify({"success": True})


@app.route("/api/stats")
def stats():
    return jsonify(camera.snapshot())


@app.route("/canvas_feed")
def canvas_feed():
    return Response(draw_camera.frames(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/api/canvas/start", methods=["POST"])
def start_canvas():
    ok, error = draw_camera.start()
    status_code = 200 if ok else 500
    return jsonify({"success": ok, "error": error}), status_code


@app.route("/api/canvas/stop", methods=["POST"])
def stop_canvas():
    draw_camera.stop()
    return jsonify({"success": True})


@app.route("/api/canvas/clear", methods=["POST"])
def clear_canvas():
    draw_camera.clear()
    return jsonify({"success": True})


@app.route("/api/canvas/color", methods=["POST"])
def set_canvas_color():
    from flask import request
    name = (request.json or {}).get("color", "")
    if name not in PALETTE:
        return jsonify({"success": False, "error": "Unknown color"}), 400
    draw_camera.set_color(name)
    return jsonify({"success": True, "color": name})


@app.route("/api/canvas/thickness", methods=["POST"])
def set_canvas_thickness():
    from flask import request
    value = (request.json or {}).get("thickness", 6)
    draw_camera.set_thickness(value)
    return jsonify({"success": True, "thickness": draw_camera.canvas.thickness if draw_camera.canvas else value})


@app.route("/api/canvas/status")
def canvas_status():
    return jsonify(draw_camera.status())


@app.route("/api/canvas/download")
def download_canvas():
    png_bytes = draw_camera.export_png()
    if png_bytes is None:
        return jsonify({"success": False, "error": "No artwork yet."}), 404
    return send_file(
        io.BytesIO(png_bytes),
        mimetype="image/png",
        as_attachment=True,
        download_name="air-canvas-artwork.png",
    )


if __name__ == "__main__":
    app.run(debug=True, threaded=True, host="0.0.0.0", port=5000)
