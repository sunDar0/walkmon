#!/usr/bin/env python3
"""slice_sheet.py — walkmon 스프라이트 시트 → 텍스처 팩 아틀라스 슬라이서.

용도
  균등 격자(rows x cols)로 배열된 픽셀 아트 스프라이트 시트 PNG 를 받아,
  각 셀을 잘라 알파 바운딩박스로 trim 한 뒤 여백 최소로 팩해
  walkmon 이 소비하는 아틀라스 한 쌍을 만든다:
    - <name>_packed.png         (팩된 아틀라스 이미지)
    - <name>_coordinate.json    (프레임 좌표, 아래 스키마)

출력 coordinate.json 스키마 (walkmon 규격 — grid/monster/player_coordinate.json 과 동일)
  {
    "image": "<name>_packed.png",
    "size": { "w": <아틀라스 폭>, "h": <아틀라스 높이> },
    "frames": [
      { "name": "sprite_<row>_<col>", "x": <아틀라스내 x>, "y": <아틀라스내 y>,
        "w": <trim 된 프레임 폭>, "h": <trim 된 프레임 높이> }
    ]
  }
  - w/h 는 알파 바운딩박스로 trim 된 실제 스프라이트 크기(프레임마다 다름).
  - x/y 는 팩된 아틀라스 안 위치. name 은 sprite_{row}_{col} (원본 격자 좌표).
  - 완전 투명(빈) 셀은 스킵한다 — frames 에 들어가지 않는다.
  - PixelHexMap.js 가 frames[].name / {x,y,w,h} 로 이 아틀라스를 소비한다.

픽셀 아트 전제
  - 리사이즈·안티앨리어싱을 하지 않는다. crop/trim/paste 만 하므로 원본 픽셀이 그대로 보존된다.
  - 결정적 출력: 같은 입력·같은 인자면 항상 같은 팩 결과.

패킹
  간단한 shelf(행) 패커. 원본 격자의 각 row 를 아틀라스의 한 shelf 로 만든다
  (프레임은 col 순으로 좌->우, shelf 높이는 그 row 의 최대 trim 높이). 프레임 사이·바깥에
  --padding(기본 2px) 여백을 둔다. 격자 정렬이 아니라 여백 최소 배치라 프레임 x/y 가 제각각이다.

의존성
  Pillow(PIL). 미설치 시:  pip install Pillow

예시
  # 4행 6열 시트를 monster 아틀라스로 (assets/pet/ 에 출력)
  python3 slice_sheet.py --sheet raw_monster.png --rows 4 --cols 6 \
      --name monster --out-dir assets/pet

  # 셀 크기를 직접 지정(시트가 rows/cols 로 정확히 안 나눠떨어질 때)
  python3 slice_sheet.py --sheet raw.png --rows 4 --cols 6 \
      --cell-w 64 --cell-h 64 --name tiles --out-dir assets/tiles
"""

import argparse
import json
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow(PIL) 가 필요합니다. 설치:  pip install Pillow")


def slice_sheet(sheet_path, rows, cols, name, out_dir, padding, cell_w=None, cell_h=None):
    sheet = Image.open(sheet_path).convert("RGBA")
    sheet_w, sheet_h = sheet.size

    # 셀 크기: 명시값 우선, 없으면 시트를 rows/cols 로 균등 분할.
    cw = cell_w if cell_w else sheet_w // cols
    ch = cell_h if cell_h else sheet_h // rows
    if cw <= 0 or ch <= 0:
        sys.exit("셀 크기가 0 이하입니다. --rows/--cols 또는 --cell-w/--cell-h 를 확인하세요.")

    # 1) 각 셀 crop -> 알파 bbox 로 trim. 완전 투명 셀은 스킵.
    #    row 순서 유지(결정적). trimmed[r] = [(col, cropped_image, w, h), ...]
    trimmed_rows = []
    for r in range(rows):
        row_cells = []
        for c in range(cols):
            left, top = c * cw, r * ch
            cell = sheet.crop((left, top, left + cw, top + ch))
            # 알파 채널 기준 bbox — 투명 여백을 제거한다(리샘플 없음).
            bbox = cell.getchannel("A").getbbox()
            if bbox is None:
                continue  # 완전 투명 = 빈 셀
            sprite = cell.crop(bbox)
            row_cells.append((c, sprite, sprite.width, sprite.height))
        trimmed_rows.append(row_cells)

    # 2) shelf 패킹: 원본 row -> 아틀라스 shelf. 프레임 사이·바깥에 padding.
    frames = []
    placements = []  # (sprite_image, x, y)
    atlas_w = 0
    y = padding
    for r, row_cells in enumerate(trimmed_rows):
        if not row_cells:
            continue
        x = padding
        shelf_h = max(h for (_, _, _, h) in row_cells)
        for (c, sprite, w, h) in row_cells:
            frames.append({"name": f"sprite_{r}_{c}", "x": x, "y": y, "w": w, "h": h})
            placements.append((sprite, x, y))
            x += w + padding
        atlas_w = max(atlas_w, x)
        y += shelf_h + padding
    atlas_h = y

    if not frames:
        sys.exit("추출된 프레임이 없습니다(모든 셀이 투명이거나 격자 설정이 틀렸습니다).")

    # 3) 아틀라스 합성 — nearest 그대로(단순 paste, 리샘플 없음).
    atlas = Image.new("RGBA", (atlas_w, atlas_h), (0, 0, 0, 0))
    for sprite, x, y in placements:
        atlas.paste(sprite, (x, y))

    os.makedirs(out_dir, exist_ok=True)
    png_path = os.path.join(out_dir, f"{name}_packed.png")
    json_path = os.path.join(out_dir, f"{name}_coordinate.json")

    atlas.save(png_path)
    coordinate = {
        "image": f"{name}_packed.png",
        "size": {"w": atlas_w, "h": atlas_h},
        "frames": frames,
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(coordinate, f, ensure_ascii=False, indent=2)

    return png_path, json_path, len(frames), (atlas_w, atlas_h)


def main():
    ap = argparse.ArgumentParser(description="walkmon 스프라이트 시트 슬라이서 (격자 시트 -> 텍스처 팩 아틀라스)")
    ap.add_argument("--sheet", required=True, help="입력 스프라이트 시트 PNG 경로")
    ap.add_argument("--rows", type=int, required=True, help="격자 행 수")
    ap.add_argument("--cols", type=int, required=True, help="격자 열 수")
    ap.add_argument("--name", help="출력 접두사(예: monster). 기본: 시트 파일명")
    ap.add_argument("--out-dir", default=".", help="출력 디렉터리(기본: 현재 폴더)")
    ap.add_argument("--padding", type=int, default=2, help="프레임 사이·바깥 여백 px(기본 2)")
    ap.add_argument("--cell-w", type=int, help="셀 폭 직접 지정(기본: sheet_w // cols)")
    ap.add_argument("--cell-h", type=int, help="셀 높이 직접 지정(기본: sheet_h // rows)")
    args = ap.parse_args()

    name = args.name or os.path.splitext(os.path.basename(args.sheet))[0]
    png_path, json_path, n, (aw, ah) = slice_sheet(
        args.sheet, args.rows, args.cols, name, args.out_dir,
        args.padding, args.cell_w, args.cell_h,
    )
    print(f"프레임 {n}개 추출 -> 아틀라스 {aw}x{ah}")
    print(f"  {png_path}")
    print(f"  {json_path}")


if __name__ == "__main__":
    main()
