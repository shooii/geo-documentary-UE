import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const sourceDir = fileURLToPath(new URL('../unreal/GeoDocumentary/Source/GeoDocumentary/', import.meta.url));
test('P1执行原生共用布局算法：原位、四边、字幕、稳定格位及引线裁切', t => {
  const compiler = ['clang++', 'g++'].find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
  if (!compiler) { t.skip('未找到独立C++编译器，原生布局算法需在集中编译时验证'); return; }
  t.diagnostic(`独立布局编译器：${compiler}，C++17，-Wall -Wextra -Werror`);
  const dir = mkdtempSync(join(tmpdir(), 'geo-focus-label-'));
  try {
    const source = join(dir, 'focus.cpp');
    const binary = join(dir, process.platform === 'win32' ? 'focus.exe' : 'focus');
    writeFileSync(source, `#include "GeoFocusLabelLayout.h"
#include <cassert>
using namespace GeoFocusLabel;
int main() {
  const Rect safe{20,20,1060,1900}, subtitle{120,1400,960,1580};
  const auto badge=WithIcon({200,70},64,8);
  assert(badge.Half.X == 236 && badge.Half.Y == 70 && badge.TextOffset == 36);
  // 图标和名称共同计入避让边框，两个部分均完整位于名牌内部。
  const auto badgePlacement=Place(Rect{-100,-100,100,100},badge.Half,safe,&subtitle,1,12);
  assert(badgePlacement.Valid);
  const double badgeCenter=(badgePlacement.Bounds.Left+badgePlacement.Bounds.Right)*.5;
  assert(badgePlacement.Bounds.Left+badge.IconSize+8 == badgeCenter+badge.TextOffset-200);
  assert(badgeCenter+badge.TextOffset+200 == badgePlacement.Bounds.Right);
  const Rect original{300,700,780,1000};
  auto p = Place(original,{200,70},safe,&subtitle,1,12);
  assert(p.Valid && p.Candidate == 0 && p.Bounds.Left == original.Left);
  const Rect collisions[] = {{-20,500,400,800},{800,500,1100,800},
    {300,-40,700,200},{300,1800,700,2000},{300,1300,700,1500},
    {-400,-400,-100,-100}};
  for (const auto& box : collisions) {
    p = Place(box,{200,70},safe,&subtitle,1,12);
    assert(p.Valid && p.Candidate > 0);
    assert(Clearance(p.Bounds,safe,&subtitle,1) >= 12 - 1e-6);
  }
  const auto fixed = Place(collisions[0],{200,70},safe,&subtitle,1,12);
  for (int i=0;i<1000;++i) {
    Rect moving=collisions[0]; moving.Left += i*.001; moving.Right += i*.001;
    p=Place(moving,{200,70},safe,&subtitle,1,12);
    assert(p.Candidate == fixed.Candidate && p.Bounds.Left == fixed.Bounds.Left
      && p.Bounds.Top == fixed.Bounds.Top);
  }
  // 字幕出现/消失及随机采样不依赖上一帧。
  for (int i=0;i<20;++i) {
    Place(original,{200,70},safe,nullptr,0,12);
    p=Place(collisions[4],{200,70},safe,&subtitle,1,12);
    assert(p.Valid && p.Candidate == fixed.Candidate);
  }
  const Rect first{20,20,1060,210};
  p=Place(collisions[0],{200,70},safe,&first,1,12);
  assert(p.Valid && p.Bounds.Top >= 222);
  const Rect all{20,20,1060,1900};
  assert(!Place(original,{200,70},safe,&all,1,12).Valid);
  assert(!Place(collisions[0],{600,70},safe,nullptr,0,12).Valid);
  const auto start=Nearest(Rect{300,300,700,440},Point{540,1500});
  auto end=ClipLeader(start,{540,1500},&subtitle,1,4);
  assert(end.Y <= subtitle.Top-4 && end.Y > start.Y);
  end=ClipLeader(start,{540,1000},&subtitle,1,4);
  assert(end.X == 540 && end.Y == 1000);
  const Rect side{500,500,700,800};
  end=ClipLeader({400,600},{800,600},&side,1,4);
  assert(end.X == 496 && end.Y == 600);
  end=ClipLeader({800,600},{400,600},&side,1,4);
  assert(end.X == 704 && end.Y == 600);
  end=ClipLeader({600,600},{800,600},&side,1,4);
  assert(end.X == 600 && end.Y == 600);
  end=ClipLeader({400,400},{400,400},&side,1,4);
  assert(end.X == 400 && end.Y == 400);
  const Rect obstacles[] = {subtitle, side};
  end=ClipLeader({540,440},{540,1800},obstacles,2,4);
  assert(end.Y == 496);
  const auto edge=Nearest(safe,{-500,2000});
  assert(edge.X == safe.Left && edge.Y == safe.Bottom);
  // 横竖屏和缩放只改变像素坐标，不改变固定格位、间距或完整图标占位。
  const Rect frames[] = {{20,20,1060,1900},{20,20,1900,1060}};
  for (const Rect& frame : frames) {
    const Rect blocked{frame.Left,frame.Bottom-200,frame.Right,frame.Bottom};
    const auto base=Place(collisions[0],badge.Half,frame,&blocked,1,12);
    assert(base.Valid);
    for (const double scale : {.5,1.,2.}) {
      const auto scaled=[scale](Rect r) {
        return Rect{r.Left*scale,r.Top*scale,r.Right*scale,r.Bottom*scale};
      };
      const Rect scaledBlocked=scaled(blocked);
      const auto q=Place(scaled(collisions[0]),{badge.Half.X*scale,badge.Half.Y*scale},
        scaled(frame),&scaledBlocked,1,12*scale);
      assert(q.Valid && q.Candidate == base.Candidate);
      assert(std::abs(q.Bounds.Left-base.Bounds.Left*scale) < 1e-6);
      assert(std::abs(q.Bounds.Top-base.Bounds.Top*scale) < 1e-6);
      assert(Clearance(q.Bounds,scaled(frame),&scaledBlocked,1) >= 12*scale-1e-6);
    }
  }
}
`);
    const built = spawnSync(compiler, ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', sourceDir, source, '-o', binary], { encoding: 'utf8' });
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
    const ran = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('原生HUD接入共用helper且仅当前目标使用兜底，不改变历史alpha', () => {
  const source = readFileSync(join(sourceDir, 'GeoMap.cpp'), 'utf8');
  const start = source.indexOf('        bool Fallback = false;');
  const end = source.indexOf('        const FVector2D Position = Bounds.GetCenter();', start);
  const layout = source.slice(start, end);
  assert.match(layout, /if \(Label.Priority == 2 && !Current.IsEmpty\(\)\)/);
  assert.match(layout, /GeoFocusLabel::Place\(/);
  assert.match(layout, /GeoFocusLabel::ClipLeader\(/);
  assert.match(layout, /if \(!Fallback && Pinned && LabelPin\)/);
  assert.match(layout, /Label.Color.A \*= LayoutAlpha/);
  assert.match(layout, /Label.Fade \* .7f/);
  assert.match(layout, /GeoFocusLabel::WithIcon/);
  assert.match(layout, /BadgeIcon.Texture = LabelPin->GetResource\(\)/);
  assert.match(layout, /FVector2D\(Badge.TextOffset, 0\)/);
  assert.match(layout, /Placements.Add\(Label.Id, -1\)/);
  assert.match(layout, /fallback=no-space/);
  assert.match(layout, /FCanvasTriangleItem Line\(BatchTriangleScratch, GWhiteTexture\)/);
  assert.match(layout, /Line.BlendMode = SE_BLEND_Translucent/);
  assert.doesNotMatch(layout, /FCanvasLineItem (Leader|Mark)/);
  assert.match(layout, /DrawAlphaLine\(Points\[I - 1\], Points\[I\], 2 \* Scale, BadgeColor\)/);
  // 普通及无current的收尾标签仍走原位Point/Bounds，不进入Priority2分支。
  assert.match(source, /CurrentVillage \? 2 : Label.Parent \? 1 : 0/);
  assert.match(source, /const FVector2D Point = Label.Anchor \+ FVector2D\(0, BaseY\)/);
  assert.match(source, /Current.IsEmpty\(\) \|\| Label.Parent \|\| Label.Id != CurrentId/);
  assert.doesNotMatch(layout, /LabelPlacements\.Find|LabelPlacements\.Contains/);
});

test('投影失败和无空间诊断按当前目标及状态去重，场景或画幅变更才重置', () => {
  const source = readFileSync(join(sourceDir, 'GeoMap.cpp'), 'utf8');
  const header = readFileSync(join(sourceDir, 'GeoMap.h'), 'utf8');
  assert.match(header, /TSet<FString> FocusLabelWarnings/);
  assert.match(source, /if \(LabelGeneration != Map->Generation \|\| CachedSize != Size\)[\s\S]*?FocusLabelWarnings.Reset\(\)/);
  const projection = source.slice(source.indexOf('        if (!ToScreen(Label.Position, Point))'),
    source.indexOf('        // The shader\'s NearFarScalar'));
  assert.match(projection, /!Current.IsEmpty\(\) && !Label.Parent && Label.Id == Current/);
  assert.match(projection, /Label.Id \+ TEXT\(":projection"\)/);
  assert.match(projection, /if \(!FocusLabelWarnings.Contains\(Warning\)\)[\s\S]*?FocusLabelWarnings.Add\(Warning\);[\s\S]*?fallback=projection-unavailable/);
  const noSpace = source.slice(source.indexOf('            if (!Placement.Valid)'));
  assert.match(noSpace, /Label.Id \+ TEXT\(":no-space"\)/);
  assert.match(noSpace, /if \(!FocusLabelWarnings.Contains\(Warning\)\)[\s\S]*?FocusLabelWarnings.Add\(Warning\);[\s\S]*?fallback=no-space/);
  assert.equal(source.match(/FocusLabelWarnings.Reset\(\)/g)?.length, 1);
});
