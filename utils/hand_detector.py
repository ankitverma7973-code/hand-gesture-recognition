"""
hand_detector.py
-----------------
Thin wrapper around MediaPipe Hands that:
  1. Runs multi-hand landmark detection on a BGR frame (up to `max_hands`).
  2. Draws a custom "HUD" style skeleton (glowing nodes + connecting rails)
     instead of the default MediaPipe drawing style, to match the
     application's visual language.

Only detection / drawing concerns live here. Gesture interpretation is
handled separately in gesture_classifier.py so each module has one job.
"""

import cv2
import mediapipe as mp

# Colour palette (BGR because OpenCV) — mirrors the CSS accent colours.
COLOR_LINE = (255, 197, 0)      # electric cyan-teal rails   (#00C5FF-ish in BGR)
COLOR_NODE = (255, 255, 255)    # bright node core
COLOR_NODE_RING = (255, 92, 124)  # violet accent ring        (#7C5CFF-ish in BGR)
COLOR_TIP = (0, 213, 126)       # fingertip highlight        (#7ED500-ish in BGR)

# Second hand gets a distinct rail colour so two-hand mode is easy to read.
COLOR_LINE_2 = (255, 92, 124)

FINGER_TIP_IDS = {4, 8, 12, 16, 20}


class HandDetector:
    """Detects up to `max_hands` hands and exposes both raw landmarks per
    hand and a ready-to-draw annotated frame."""

    def __init__(self, max_hands=1, detection_confidence=0.7, tracking_confidence=0.6):
        self.mp_hands = mp.solutions.hands
        self.max_hands = max_hands
        self.hands = self.mp_hands.Hands(
            static_image_mode=False,
            max_num_hands=max_hands,
            min_detection_confidence=detection_confidence,
            min_tracking_confidence=tracking_confidence,
        )
        self.connections = self.mp_hands.HAND_CONNECTIONS

    def find_hands(self, frame_bgr):
        """Runs inference on a BGR frame.

        Returns:
            list[dict]: one entry per detected hand (up to max_hands), each:
                {
                  "landmarks": [21 landmark dicts with x, y (pixel) and
                                 nx, ny, nz (normalized)],
                  "handedness": "Left" | "Right",
                  "score": float (0-1 classification confidence),
                }
            Empty list if no hand was found.
        """
        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        frame_rgb.flags.writeable = False
        results = self.hands.process(frame_rgb)

        if not results.multi_hand_landmarks:
            return []

        h, w = frame_bgr.shape[:2]
        hands_out = []

        for hand_index, hand_landmarks in enumerate(results.multi_hand_landmarks):
            landmarks = []
            for idx, lm in enumerate(hand_landmarks.landmark):
                landmarks.append({
                    "id": idx,
                    "x": int(lm.x * w),
                    "y": int(lm.y * h),
                    "nx": lm.x,
                    "ny": lm.y,
                    "nz": lm.z,
                })

            handedness = "Right"
            score = 0.0
            if results.multi_handedness and hand_index < len(results.multi_handedness):
                classification = results.multi_handedness[hand_index].classification[0]
                # Frames are mirrored (selfie-view) before detection, which
                # flips MediaPipe's left/right classification relative to
                # what the user visually sees — so we invert the label here
                # to match what's on screen.
                handedness = "Left" if classification.label == "Right" else "Right"
                score = classification.score

            hands_out.append({
                "landmarks": landmarks,
                "handedness": handedness,
                "score": score,
            })

        return hands_out

    def draw_landmarks(self, frame_bgr, landmarks, hand_slot=0):
        """Draws the HUD-style skeleton for one hand's landmarks onto
        frame_bgr in place and returns the modified frame. `hand_slot`
        picks the rail colour (0 = teal, 1 = violet) so two hands stay
        visually distinct."""
        if not landmarks:
            return frame_bgr

        line_color = COLOR_LINE if hand_slot == 0 else COLOR_LINE_2
        points = {lm["id"]: (lm["x"], lm["y"]) for lm in landmarks}

        for start_idx, end_idx in self.connections:
            if start_idx in points and end_idx in points:
                cv2.line(frame_bgr, points[start_idx], points[end_idx], line_color, 2, cv2.LINE_AA)

        for idx, (x, y) in points.items():
            if idx in FINGER_TIP_IDS:
                cv2.circle(frame_bgr, (x, y), 8, COLOR_TIP, -1, cv2.LINE_AA)
                cv2.circle(frame_bgr, (x, y), 8, COLOR_NODE, 1, cv2.LINE_AA)
            else:
                cv2.circle(frame_bgr, (x, y), 5, COLOR_NODE_RING, -1, cv2.LINE_AA)
                cv2.circle(frame_bgr, (x, y), 5, COLOR_NODE, 1, cv2.LINE_AA)

        return frame_bgr

    def close(self):
        self.hands.close()
