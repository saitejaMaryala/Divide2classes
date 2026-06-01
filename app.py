import os
import json
import re
from pathlib import Path
from flask import Flask, jsonify, request, send_file, render_template, abort

app = Flask(__name__)

SUPPORTED_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff', '.webp'}
ANNOTATIONS_FILENAME = 'annotations.json'
DEFAULT_FOLDER = '/ssd_scratch/sai.teja/tr_test_results_mod/defaultBest/fp_classified'

# In-memory state
state = {
    'folder_path': None,
    'images': [],            # only 3r images, sorted
    'tracks': [],            # list of track_keys in sorted order
    'track_map': {},         # track_key -> [img_name, ...]  (sorted by frame, 3r only)
    'track_all_count': {},   # track_key -> total frame count (3r + non-3r)
    'annotations': {},       # class_name -> [img_name, ...]
    'current_index': 0,      # index into state['images']
}


# ─── Filename parsing ───────────────────────────────────────────────────────

def parse_filename(name):
    """
    Parse a filename like:  20211110090522_0060_2001_890_3r.jpg
    Returns dict with video_name, aid, frame, track_key, is_3r
    or None if it doesn't match the expected pattern.

    Format: {video_name}_{aid}_{frame}[_3r].jpg
    video_name itself contains underscores (e.g. 20211110090522_0060).
    We identify parts from the right:
      - last part (before ext): '3r' or numeric frame
      - if last = '3r': second-to-last = frame, third-to-last = aid
      - else: last = frame, second-to-last = aid
    Everything to the left of aid is video_name.
    """
    stem = Path(name).stem  # remove extension
    parts = stem.split('_')

    if len(parts) < 4:
        return None

    if parts[-1] == '3r':
        # ..._{video_name}_{aid}_{frame}_3r
        frame = parts[-2]
        aid   = parts[-3]
        video_name = '_'.join(parts[:-3])
        is_3r = True
    else:
        # ..._{video_name}_{aid}_{frame}
        frame = parts[-1]
        aid   = parts[-2]
        video_name = '_'.join(parts[:-2])
        is_3r = False

    track_key = f"{video_name}_{aid}"
    return {
        'video_name': video_name,
        'aid': aid,
        'frame': int(frame) if frame.isdigit() else frame,
        'track_key': track_key,
        'is_3r': is_3r,
    }


# ─── Annotation helpers ──────────────────────────────────────────────────────

def build_track_all_count(folder_path):
    """Count ALL frames (3r + non-3r) per track_key in the folder."""
    counts = {}
    for f in os.listdir(folder_path):
        ext = Path(f).suffix.lower()
        if ext not in SUPPORTED_EXTENSIONS:
            continue
        parsed = parse_filename(f)
        if parsed:
            counts[parsed['track_key']] = counts.get(parsed['track_key'], 0) + 1
    return counts


def get_annotations_path():
    if state['folder_path']:
        return os.path.join(state['folder_path'], ANNOTATIONS_FILENAME)
    return None


def load_annotations():
    path = get_annotations_path()
    if path and os.path.exists(path):
        try:
            with open(path, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {}
    return {}


def save_annotations():
    path = get_annotations_path()
    if path:
        with open(path, 'w') as f:
            json.dump(state['annotations'], f, indent=2)


def get_image_annotation_map():
    """Returns {img_name: class_name} for quick lookup."""
    result = {}
    for cls, imgs in state['annotations'].items():
        for img in imgs:
            result[img] = cls
    return result


# ─── Routes ─────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/load_folder', methods=['POST'])
def load_folder():
    data = request.get_json()
    folder_path = data.get('folder_path', '').strip()

    if not folder_path:
        return jsonify({'error': 'No folder path provided.'}), 400

    if not os.path.isdir(folder_path):
        return jsonify({'error': f'Directory not found: {folder_path}'}), 404

    # Collect only 3r images
    all_parsed = []
    for f in os.listdir(folder_path):
        ext = Path(f).suffix.lower()
        if ext not in SUPPORTED_EXTENSIONS:
            continue
        parsed = parse_filename(f)
        if parsed and parsed['is_3r']:
            all_parsed.append((f, parsed))

    if not all_parsed:
        return jsonify({'error': 'No triple-riding (3r) images found in the directory.'}), 404

    # Sort by track_key then frame
    all_parsed.sort(key=lambda x: (x[1]['track_key'], x[1]['frame']))

    images = [item[0] for item in all_parsed]

    # Build 3r-only track map
    track_map = {}
    for fname, parsed in all_parsed:
        tk = parsed['track_key']
        track_map.setdefault(tk, []).append(fname)

    tracks = sorted(track_map.keys())

    # Count ALL frames (3r + non-3r) per track
    track_all_count = build_track_all_count(folder_path)

    state['folder_path']     = folder_path
    state['images']          = images
    state['tracks']          = tracks
    state['track_map']       = track_map
    state['track_all_count'] = track_all_count
    state['current_index']   = 0
    state['annotations']     = load_annotations()

    return jsonify({
        'success': True,
        'total': len(images),
        'total_tracks': len(tracks),
        'current_index': 0,
        'folder_path': folder_path,
    })


@app.route('/api/status', methods=['GET'])
def get_status():
    if not state['folder_path']:
        return jsonify({'loaded': False})

    img_map = get_image_annotation_map()
    annotated_count = sum(1 for img in state['images'] if img in img_map)

    return jsonify({
        'loaded': True,
        'total': len(state['images']),
        'total_tracks': len(state['tracks']),
        'annotated': annotated_count,
        'current_index': state['current_index'],
        'classes': list(state['annotations'].keys()),
        'image_annotation_map': img_map,
        'images': state['images'],
        'tracks': state['tracks'],
        'track_map': state['track_map'],
    })


@app.route('/api/image/<int:index>', methods=['GET'])
def get_image(index):
    if not state['folder_path']:
        abort(404)
    if index < 0 or index >= len(state['images']):
        abort(404)

    img_name = state['images'][index]
    img_path = os.path.join(state['folder_path'], img_name)

    if not os.path.exists(img_path):
        abort(404)

    state['current_index'] = index
    return send_file(img_path)


@app.route('/api/image_info/<int:index>', methods=['GET'])
def get_image_info(index):
    if not state['folder_path']:
        return jsonify({'error': 'No folder loaded'}), 400
    if index < 0 or index >= len(state['images']):
        return jsonify({'error': 'Index out of range'}), 400

    img_name = state['images'][index]
    img_map = get_image_annotation_map()
    current_class = img_map.get(img_name)

    parsed = parse_filename(img_name)
    track_key = parsed['track_key'] if parsed else None
    track_index = state['tracks'].index(track_key) if track_key in state['tracks'] else None

    # Position within the track
    track_imgs = state['track_map'].get(track_key, [])
    pos_in_track = track_imgs.index(img_name) + 1 if img_name in track_imgs else None
    track_all_frames = state['track_all_count'].get(track_key, len(track_imgs))

    return jsonify({
        'index': index,
        'name': img_name,
        'class': current_class,
        'total': len(state['images']),
        'total_tracks': len(state['tracks']),
        'track_key': track_key,
        'track_index': track_index,          # 0-based index of track in sorted list
        'track_size': len(track_imgs),       # number of 3r frames in this track
        'track_all_frames': track_all_frames,# total frames (3r + non-3r)
        'pos_in_track': pos_in_track,        # 1-based position in track
        'frame': parsed['frame'] if parsed else None,
        'video_name': parsed['video_name'] if parsed else None,
        'aid': parsed['aid'] if parsed else None,
    })


@app.route('/api/annotate', methods=['POST'])
def annotate():
    if not state['folder_path']:
        return jsonify({'error': 'No folder loaded'}), 400

    data = request.get_json()
    index = data.get('index')
    class_name = data.get('class_name', '').strip()

    if index is None or index < 0 or index >= len(state['images']):
        return jsonify({'error': 'Invalid image index'}), 400

    if not class_name:
        return jsonify({'error': 'Class name cannot be empty'}), 400

    img_name = state['images'][index]

    # Remove from any existing class
    for cls in list(state['annotations'].keys()):
        if img_name in state['annotations'][cls]:
            state['annotations'][cls].remove(img_name)
            if not state['annotations'][cls]:
                del state['annotations'][cls]
            break

    # Add to new class
    if class_name not in state['annotations']:
        state['annotations'][class_name] = []
    state['annotations'][class_name].append(img_name)

    save_annotations()

    img_map = get_image_annotation_map()
    annotated_count = sum(1 for img in state['images'] if img in img_map)

    return jsonify({
        'success': True,
        'annotated': annotated_count,
        'total': len(state['images']),
        'classes': list(state['annotations'].keys()),
    })


@app.route('/api/unannotate', methods=['POST'])
def unannotate():
    if not state['folder_path']:
        return jsonify({'error': 'No folder loaded'}), 400

    data = request.get_json()
    index = data.get('index')

    if index is None or index < 0 or index >= len(state['images']):
        return jsonify({'error': 'Invalid image index'}), 400

    img_name = state['images'][index]

    for cls in list(state['annotations'].keys()):
        if img_name in state['annotations'][cls]:
            state['annotations'][cls].remove(img_name)
            if not state['annotations'][cls]:
                del state['annotations'][cls]
            break

    save_annotations()

    img_map = get_image_annotation_map()
    annotated_count = sum(1 for img in state['images'] if img in img_map)

    return jsonify({
        'success': True,
        'annotated': annotated_count,
        'total': len(state['images']),
        'classes': list(state['annotations'].keys()),
    })


@app.route('/api/navigate', methods=['POST'])
def navigate():
    if not state['folder_path']:
        return jsonify({'error': 'No folder loaded'}), 400

    data = request.get_json()
    direction = data.get('direction')  # 'next', 'prev', 'next_track', 'prev_track', 'goto_track'
    track_index = data.get('track_index')  # used with goto_track (1-based from UI)
    current = state['current_index']

    img_map = get_image_annotation_map()
    images = state['images']
    tracks = state['tracks']
    track_map = state['track_map']

    def first_index_of_track(tk):
        """Return the global index of the first image in a track."""
        imgs_in_track = track_map.get(tk, [])
        if not imgs_in_track:
            return None
        return images.index(imgs_in_track[0])

    if direction == 'next':
        new_index = min(current + 1, len(images) - 1)

    elif direction == 'prev':
        new_index = max(current - 1, 0)

    elif direction == 'next_track':
        # Find current track, jump to first image of next track
        cur_img = images[current]
        parsed = parse_filename(cur_img)
        cur_track_key = parsed['track_key'] if parsed else None
        cur_track_idx = tracks.index(cur_track_key) if cur_track_key in tracks else -1
        next_track_idx = cur_track_idx + 1
        if next_track_idx >= len(tracks):
            return jsonify({'error': 'Already at last track', 'at_end': True})
        new_index = first_index_of_track(tracks[next_track_idx])

    elif direction == 'prev_track':
        cur_img = images[current]
        parsed = parse_filename(cur_img)
        cur_track_key = parsed['track_key'] if parsed else None
        cur_track_idx = tracks.index(cur_track_key) if cur_track_key in tracks else 0
        prev_track_idx = cur_track_idx - 1
        if prev_track_idx < 0:
            return jsonify({'error': 'Already at first track', 'at_start': True})
        new_index = first_index_of_track(tracks[prev_track_idx])

    elif direction == 'goto_track':
        # track_index is 1-based
        if track_index is None or track_index < 1 or track_index > len(tracks):
            return jsonify({'error': f'Track index must be between 1 and {len(tracks)}'}), 400
        new_index = first_index_of_track(tracks[track_index - 1])

    else:
        return jsonify({'error': 'Invalid direction'}), 400

    if new_index is None:
        return jsonify({'error': 'Could not find track'}), 400

    state['current_index'] = new_index
    img_name = images[new_index]
    current_class = img_map.get(img_name)
    parsed = parse_filename(img_name)
    track_key = parsed['track_key'] if parsed else None
    track_imgs = track_map.get(track_key, [])
    pos_in_track = track_imgs.index(img_name) + 1 if img_name in track_imgs else None
    track_idx_0 = tracks.index(track_key) if track_key in tracks else None
    track_all_frames = state['track_all_count'].get(track_key, len(track_imgs))

    return jsonify({
        'index': new_index,
        'name': img_name,
        'class': current_class,
        'total': len(images),
        'total_tracks': len(tracks),
        'track_key': track_key,
        'track_index': track_idx_0,
        'track_size': len(track_imgs),
        'track_all_frames': track_all_frames,
        'pos_in_track': pos_in_track,
        'frame': parsed['frame'] if parsed else None,
        'video_name': parsed['video_name'] if parsed else None,
        'aid': parsed['aid'] if parsed else None,
    })


@app.route('/api/classes', methods=['GET'])
def get_classes():
    return jsonify({'classes': list(state['annotations'].keys())})


@app.route('/api/export', methods=['GET'])
def export_annotations():
    if not state['folder_path']:
        return jsonify({'error': 'No folder loaded'}), 400
    return jsonify(state['annotations'])


def _auto_load(folder_path):
    """Load a folder at startup so the UI skips the setup screen."""
    if not os.path.isdir(folder_path):
        print(f'[auto-load] Directory not found: {folder_path}')
        return

    all_parsed = []
    for f in os.listdir(folder_path):
        ext = Path(f).suffix.lower()
        if ext not in SUPPORTED_EXTENSIONS:
            continue
        parsed = parse_filename(f)
        if parsed and parsed['is_3r']:
            all_parsed.append((f, parsed))

    if not all_parsed:
        print('[auto-load] No 3r images found.')
        return

    all_parsed.sort(key=lambda x: (x[1]['track_key'], x[1]['frame']))
    images = [item[0] for item in all_parsed]

    track_map = {}
    for fname, parsed in all_parsed:
        tk = parsed['track_key']
        track_map.setdefault(tk, []).append(fname)

    tracks = sorted(track_map.keys())

    # Count ALL frames (3r + non-3r) per track
    track_all_count = build_track_all_count(folder_path)

    state['folder_path']     = folder_path
    state['images']          = images
    state['tracks']          = tracks
    state['track_map']       = track_map
    state['track_all_count'] = track_all_count
    state['current_index']   = 0
    state['annotations']     = load_annotations()

    print(f'[auto-load] Loaded {len(images)} 3r images across {len(tracks)} tracks from {folder_path}')


if __name__ == '__main__':
    _auto_load(DEFAULT_FOLDER)
    app.run(host='0.0.0.0', debug=True, port=5002)
