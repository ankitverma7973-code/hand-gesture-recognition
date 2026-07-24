"""
gesture_classifier.py
----------------------
Converts 21 MediaPipe hand landmarks into one of the supported gesture
labels:

    Open Palm, Fist, One Finger, Two Fingers, Three Fingers,
    Four Fingers, Five Fingers, Thumbs Up, Thumbs Down, OK Sign,
    Rock On, Call Me

The logic is purely geometric (no ML model) so it's fast, dependency-free
and easy to read / extend.
"""

TIP_IDS = [4, 8, 12, 16, 20]      # thumb, index, middle, ring, pinky tips
PIP_IDS = [3, 6, 10, 14, 18]      # the joint just below each tip
WRIST_ID = 0

GESTURE_LABELS = {
    "OPEN_PALM": "Open Palm",
    "FIST": "Fist",
    "ONE": "One Finger",
    "TWO": "Two Fingers (Peace)",
    "THREE": "Three Fingers",
    "FOUR": "Four Fingers",
    "FIVE": "Five Fingers",
    "THUMBS_UP": "Thumbs Up",
    "THUMBS_DOWN": "Thumbs Down",
    "OK": "OK Sign",
    "ROCK_ON": "Rock On",
    "CALL_ME": "Call Me",
    "UNKNOWN": "Analyzing...",
}


def get_finger_states(landmarks):
    """Public wrapper around _finger_states — returns [thumb, index,
    middle, ring, pinky] booleans. Used by other features (e.g. the Air
    Canvas drawing mode) that need raw finger-up/down state without a
    full gesture label."""
    return _finger_states(landmarks)


def _finger_states(landmarks):
    """Returns a list of 5 booleans [thumb, index, middle, ring, pinky]
    describing whether each finger is extended."""
    by_id = {lm["id"]: lm for lm in landmarks}
    states = []

    # Thumb: compare horizontal distance of the tip vs its IP joint to the
    # palm center (wrist). Extended thumb sits further away from the palm
    # on the x-axis than its own IP joint.
    wrist_x = by_id[WRIST_ID]["nx"]
    thumb_tip_x = by_id[TIP_IDS[0]]["nx"]
    thumb_ip_x = by_id[PIP_IDS[0]]["nx"]
    thumb_extended = abs(thumb_tip_x - wrist_x) > abs(thumb_ip_x - wrist_x) * 1.05
    states.append(thumb_extended)

    # Remaining 4 fingers: extended when the tip is above (smaller y) than
    # the pip joint, since image y grows downward.
    for tip_id, pip_id in zip(TIP_IDS[1:], PIP_IDS[1:]):
        tip_y = by_id[tip_id]["ny"]
        pip_y = by_id[pip_id]["ny"]
        states.append(tip_y < pip_y - 0.015)

    return states


def _is_thumb_pointing_up(landmarks):
    by_id = {lm["id"]: lm for lm in landmarks}
    thumb_tip_y = by_id[4]["ny"]
    thumb_mcp_y = by_id[2]["ny"]
    wrist_y = by_id[WRIST_ID]["ny"]
    return thumb_tip_y < thumb_mcp_y - 0.04 and thumb_tip_y < wrist_y - 0.08


def _is_thumb_pointing_down(landmarks):
    by_id = {lm["id"]: lm for lm in landmarks}
    thumb_tip_y = by_id[4]["ny"]
    thumb_mcp_y = by_id[2]["ny"]
    wrist_y = by_id[WRIST_ID]["ny"]
    return thumb_tip_y > thumb_mcp_y + 0.04 and thumb_tip_y > wrist_y + 0.08


def _is_ok_sign(landmarks, middle, ring, pinky):
    """OK sign: thumb tip and index tip pinched close together, while the
    other three fingers stay extended. Checked independently of the
    generic thumb/index up-down flags since a pinch reads ambiguously
    under the simple extended/folded heuristic."""
    if not (middle and ring and pinky):
        return False
    by_id = {lm["id"]: lm for lm in landmarks}
    thumb_tip, index_tip = by_id[4], by_id[8]
    wrist, middle_mcp = by_id[0], by_id[9]

    pinch_dist = ((thumb_tip["nx"] - index_tip["nx"]) ** 2 + (thumb_tip["ny"] - index_tip["ny"]) ** 2) ** 0.5
    hand_scale = ((wrist["nx"] - middle_mcp["nx"]) ** 2 + (wrist["ny"] - middle_mcp["ny"]) ** 2) ** 0.5
    if hand_scale < 1e-6:
        return False
    return (pinch_dist / hand_scale) < 0.55


COMBO_RULES = {
    frozenset(["Thumbs Up", "Thumbs Up"]): "Double Thumbs Up!",
    frozenset(["Open Palm", "Open Palm"]): "High Ten!",
    frozenset(["Fist", "Fist"]): "Double Fist Bump",
    frozenset(["Two Fingers (Peace)", "Two Fingers (Peace)"]): "Double Peace",
    frozenset(["Rock On", "Rock On"]): "Double Rock On!",
    frozenset(["OK Sign", "OK Sign"]): "Double OK!",
}


def detect_combo(gesture_a, gesture_b):
    """Given two simultaneous hand gestures, returns a fun combo label if
    they match a known pair, otherwise None. Order doesn't matter, and
    matching gesture pairs (e.g. both hands Thumbs Up) collapse naturally
    since frozenset() de-duplicates identical items."""
    if not gesture_a or not gesture_b:
        return None
    return COMBO_RULES.get(frozenset([gesture_a, gesture_b]))


def classify_gesture(landmarks, detection_score=0.0):
    """Main entry point.

    Args:
        landmarks: list of 21 landmark dicts from HandDetector.find_hands
        detection_score: MediaPipe handedness classification confidence

    Returns:
        dict with keys: gesture, finger_count, confidence (0-100)
    """
    if not landmarks or len(landmarks) < 21:
        return {"gesture": GESTURE_LABELS["UNKNOWN"], "finger_count": 0, "confidence": 0}

    thumb, index, middle, ring, pinky = _finger_states(landmarks)
    non_thumb = [index, middle, ring, pinky]
    non_thumb_count = sum(non_thumb)
    total_up = int(thumb) + non_thumb_count

    # Base confidence from MediaPipe's own classification score.
    confidence = round(detection_score * 100, 1)

    # OK sign is checked first: a pinched thumb+index reads ambiguously
    # under the plain extended/folded heuristic, so we test the actual
    # pinch distance directly rather than relying on finger-state flags.
    if _is_ok_sign(landmarks, middle, ring, pinky):
        gesture = GESTURE_LABELS["OK"]
        total_up = 3  # three straight fingers + the pinched thumb/index loop
    elif total_up == 5:
        gesture = GESTURE_LABELS["OPEN_PALM"]
    elif total_up == 0:
        gesture = GESTURE_LABELS["FIST"]
    elif thumb and non_thumb_count == 0:
        if _is_thumb_pointing_up(landmarks):
            gesture = GESTURE_LABELS["THUMBS_UP"]
        elif _is_thumb_pointing_down(landmarks):
            gesture = GESTURE_LABELS["THUMBS_DOWN"]
        else:
            gesture = GESTURE_LABELS["ONE"]
    elif thumb and pinky and not index and not middle and not ring:
        gesture = GESTURE_LABELS["CALL_ME"]
        total_up = 2  # thumb + pinky, the two fingers that read visually
    elif index and pinky and not middle and not ring:
        gesture = GESTURE_LABELS["ROCK_ON"]
        total_up = 2  # index + pinky, the two fingers that read visually
    elif non_thumb_count == 1 and index:
        gesture = GESTURE_LABELS["ONE"]
    elif non_thumb_count == 2 and index and middle:
        gesture = GESTURE_LABELS["TWO"]
    elif non_thumb_count == 3 and index and middle and ring:
        gesture = GESTURE_LABELS["THREE"]
    elif non_thumb_count == 4:
        gesture = GESTURE_LABELS["FOUR"]
    else:
        gesture = GESTURE_LABELS["UNKNOWN"]
        confidence = confidence * 0.5

    return {
        "gesture": gesture,
        "finger_count": total_up,
        "confidence": max(0, min(100, confidence)),
    }
