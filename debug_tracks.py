import os
from collections import defaultdict

fp_dir = '/ssd_scratch/sai.teja/tr_test_results_mod/defaultBest/fp_classified'

if not os.path.exists(fp_dir):
    print(f'Directory does not exist: {fp_dir}')
else:
    # --- Use os.walk to catch files in subdirectories ---
    all_jpg = []
    for root, dirs, fnames in os.walk(fp_dir):
        for f in fnames:
            if f.endswith('.jpg'):
                all_jpg.append(os.path.join(root, f))

    print(f'Total images (recursive / os.walk): {len(all_jpg)}')

    # Top-level only count for comparison
    top_level = [f for f in os.listdir(fp_dir) if f.endswith('.jpg')]
    print(f'Total images (top-level only):       {len(top_level)}')
    print()

    unique_tracks = set()
    tracks_per_vid = defaultdict(set)
    skipped = []

    for fpath in all_jpg:
        fname = os.path.basename(fpath)
        base = fname.rsplit('.', 1)[0]  # remove .jpg

        has_3r = base.endswith('_3r')
        if has_3r:
            base = base[:-3]  # remove _3r suffix

        # filename pattern: {vid_name}_{gt_box_id}_{frame_num}
        parts = base.rsplit('_', 2)
        if len(parts) < 3:
            skipped.append((fname, base, parts))
            continue

        vid_name  = parts[0]
        gt_box_id = parts[1]
        unique_tracks.add((vid_name, gt_box_id))
        tracks_per_vid[vid_name].add(gt_box_id)

    print(f'Unique tracks total: {len(unique_tracks)}')
    print()

    if skipped:
        print(f'=== SKIPPED FILES ({len(skipped)}) - did not match pattern ===')
        for fname, base, parts in skipped:
            print(f'  {fname!r}  ->  base={base!r}  parts={parts}')
        print()

    print('Per-video breakdown:')
    for vid, tids in sorted(tracks_per_vid.items()):
        print(f'  {vid}: {len(tids)} tracks  -> gt_box_ids: {sorted(tids)}')

    # Extra: show a few sample filenames for inspection
    print()
    print('=== Sample filenames (first 10) ===')
    for f in sorted(all_jpg)[:10]:
        print(f'  {os.path.basename(f)}')
