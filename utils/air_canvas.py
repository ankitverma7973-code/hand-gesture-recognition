"""
air_canvas.py
-------------
"Draw in the air" using one or both index fingertips as virtual pens —
so two hands can sketch a shape together (e.g. each hand tracing one
half of a heart).

Drawing rules per hand (based on which fingers are extended):
  - Only the index finger up  -> pen down for that hand, draw a line from
    its previous fingertip position to the current one.
  - Open Palm (all 5 up)      -> clear the whole canvas (either hand).
  - Anything else (fist, two+
    fingers, thumbs up, etc.) -> pen up for that hand (move without
    drawing), so repositioning doesn't leave a stray line.

Each hand gets its own pen color (primary color for hand 0, a paired
accent color for hand 1) so two simultaneous strokes stay visually
distinct. The canvas is a persistent BGR image the same size as the
video frame; strokes accumulate on it across frames until cleared, and
it's composited on top of the live camera feed for the streamed output.
"""

import cv2
import numpy as np

from utils.gesture_classifier import get_finger_states

# Preset palette (BGR tuples) — mirrors the swatches shown in the UI.
PALETTE = {
    "teal": (166, 217, 0),
    "violet": (255, 92, 124),
    "amber": (32, 176, 255),
    "rose": (124, 92, 255),
    "white": (255, 255, 255),
}

# When two hands draw at once, the second hand automatically gets a
# paired accent color so both strokes are easy to tell apart, no matter
# which primary color the user picked.
SECONDARY_COLOR = {
    "teal": "violet",
    "violet": "teal",
    "amber": "rose",
    "rose": "amber",
    "white": "teal",
}

DEFAULT_COLOR = "teal"
DEFAULT_THICKNESS = 6
MAX_PENS = 2


class AirCanvas:
    """Owns a persistent drawing layer plus a pen-state machine per hand
    (up to two), deciding frame to frame whether each hand draws, moves,
    or triggers a clear."""

    def __init__(self, width, height):
        self.width = width
        self.height = height
        self.layer = np.zeros((height, width, 3), dtype=np.uint8)
        self.prev_points = [None] * MAX_PENS
        self.color_name = DEFAULT_COLOR
        self.thickness = DEFAULT_THICKNESS

    def set_color(self, name):
        if name in PALETTE:
            self.color_name = name

    def set_thickness(self, value):
        self.thickness = max(2, min(24, int(value)))

    def clear(self):
        self.layer[:] = 0
        self.prev_points = [None] * MAX_PENS

    def resize_if_needed(self, width, height):
        if (width, height) != (self.width, self.height):
            self.width, self.height = width, height
            self.layer = np.zeros((height, width, 3), dtype=np.uint8)
            self.prev_points = [None] * MAX_PENS

    def _color_for_slot(self, slot):
        if slot == 0:
            return PALETTE[self.color_name]
        return PALETTE[SECONDARY_COLOR.get(self.color_name, "violet")]

    def update(self, hands):
        """Advance the pen state machine by one frame.

        Args:
            hands: list of hand dicts from HandDetector.find_hands()
                (each with a "landmarks" key), 0-2 entries.

        Returns:
            str: overall pen mode — "drawing", "hover", "cleared", or "idle"
        """
        if not hands:
            self.prev_points = [None] * MAX_PENS
            return "idle"

        should_clear = False
        modes = []

        for slot in range(MAX_PENS):
            if slot >= len(hands):
                self.prev_points[slot] = None
                continue

            landmarks = hands[slot]["landmarks"]
            thumb, index, middle, ring, pinky = get_finger_states(landmarks)
            by_id = {lm["id"]: lm for lm in landmarks}
            tip = (by_id[8]["x"], by_id[8]["y"])  # index fingertip, pixel coords

            all_up = thumb and index and middle and ring and pinky
            only_index = index and not middle and not ring and not pinky

            if all_up:
                should_clear = True
                continue

            if only_index:
                color = self._color_for_slot(slot)
                prev = self.prev_points[slot]
                if prev is not None:
                    cv2.line(self.layer, prev, tip, color, self.thickness, cv2.LINE_AA)
                else:
                    cv2.circle(self.layer, tip, self.thickness // 2, color, -1, cv2.LINE_AA)
                self.prev_points[slot] = tip
                modes.append("drawing")
            else:
                # Any other hand shape: lift this hand's pen so re-entering
                # draw mode doesn't jump-connect from a stale point.
                self.prev_points[slot] = None
                modes.append("hover")

        if should_clear:
            self.clear()
            return "cleared"
        if "drawing" in modes:
            return "drawing"
        if modes:
            return "hover"
        return "idle"

    def composite(self, frame_bgr):
        """Overlays the drawing layer onto frame_bgr and returns the result."""
        mask = np.any(self.layer > 0, axis=2)
        out = frame_bgr.copy()
        out[mask] = self.layer[mask]
        return out

    def export_png_bytes(self, frame_bgr=None):
        """Encodes the current artwork as PNG bytes.

        If frame_bgr is given, the artwork is composited over that frame;
        otherwise it's exported on a plain white background.
        """
        if frame_bgr is not None:
            image = self.composite(frame_bgr)
        else:
            image = np.full((self.height, self.width, 3), 255, dtype=np.uint8)
            mask = np.any(self.layer > 0, axis=2)
            image[mask] = self.layer[mask]

        ok, buffer = cv2.imencode(".png", image)
        return buffer.tobytes() if ok else None
