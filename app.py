import os
import json
import glob
from pathlib import Path
from flask import Flask, jsonify, request, send_file, render_template, abort

app = Flask(__name__)

SUPPORTED_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff', '.webp'}
ANNOTATIONS_FILENAME = 'annotations.json'

# In-memory state
state = {
    'folder_path': None,
    'images': [],
    'annotations': {},  # class_name -> [img_name, ...]
    'current_index': 0,
}


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

    # Collect images
    images = []
    for f in sorted(os.listdir(folder_path)):
        ext = Path(f).suffix.lower()
        if ext in SUPPORTED_EXTENSIONS:
            images.append(f)

    if not images:
        return jsonify({'error': 'No supported images found in the directory.'}), 404

    state['folder_path'] = folder_path
    state['images'] = images
    state['current_index'] = 0
    state['annotations'] = load_annotations()

    # Find first unannotated image
    img_map = get_image_annotation_map()
    for i, img in enumerate(images):
        if img not in img_map:
            state['current_index'] = i
            break
    else:
        # All annotated
        state['current_index'] = 0

    return jsonify({
        'success': True,
        'total': len(images),
        'current_index': state['current_index'],
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
        'annotated': annotated_count,
        'current_index': state['current_index'],
        'classes': list(state['annotations'].keys()),
        'image_annotation_map': img_map,
        'images': state['images'],
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

    return jsonify({
        'index': index,
        'name': img_name,
        'class': current_class,
        'total': len(state['images']),
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

    # Find next unannotated image
    next_index = None
    for i in range(index + 1, len(state['images'])):
        if state['images'][i] not in img_map:
            next_index = i
            break

    return jsonify({
        'success': True,
        'annotated': annotated_count,
        'total': len(state['images']),
        'next_unannotated': next_index,
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
    direction = data.get('direction')  # 'next', 'prev', 'next_unannotated'
    current = state['current_index']

    img_map = get_image_annotation_map()

    if direction == 'next':
        new_index = min(current + 1, len(state['images']) - 1)
    elif direction == 'prev':
        new_index = max(current - 1, 0)
    elif direction == 'next_unannotated':
        new_index = None
        for i in range(len(state['images'])):
            if state['images'][i] not in img_map:
                new_index = i
                break
        if new_index is None:
            return jsonify({'error': 'All images are annotated!', 'all_done': True})
    else:
        return jsonify({'error': 'Invalid direction'}), 400

    state['current_index'] = new_index
    img_name = state['images'][new_index]
    current_class = img_map.get(img_name)

    return jsonify({
        'index': new_index,
        'name': img_name,
        'class': current_class,
        'total': len(state['images']),
    })


@app.route('/api/classes', methods=['GET'])
def get_classes():
    return jsonify({'classes': list(state['annotations'].keys())})


@app.route('/api/export', methods=['GET'])
def export_annotations():
    if not state['folder_path']:
        return jsonify({'error': 'No folder loaded'}), 400

    return jsonify(state['annotations'])


if __name__ == '__main__':
    app.run(host='0.0.0.0', debug=True, port=5002)
