import { div, svg, PathBuilder, Background } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { exec, theme, settings } from 'herdr';
import { loadGit, syncGit } from './git-data.js';

const HEIGHT = 68, STEP = 15;
const icon = (name) => `mods/workspace-chrome/${name}.svg`;
const palette = (t) => [t.ansi6, t.ansi5, t.ansi3, t.ansi4, t.ansi2, t.ansi1];
const dateLabel = (s) => { const d = new Date(s); return Number.isNaN(+d) ? s : `${d.getMonth() + 1}/${d.getDate()}`; };
const pill = (text, color, t, width = 160) => div().max_w(width).min_w(0).px(6).py(2).rounded(4).bg(t.surface).border_1().border_color(color).text_size(10).text_color(color).truncate().tooltip(text).child(text);
function action(id, text, active, t, fn, disabled = false) {
  return div().id(id).px(9).py(5).rounded(6).text_size(11).font_medium()
    .bg(active ? t.selected : t.surface).text_color(active ? t.foreground : t.muted)
    .when(disabled, (e) => e.text_color(t.dim))
    .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => fn(cx))).child(text);
}
function line(x1, y1, x2, y2, color) {
  const path = PathBuilder.stroke(1.7).move_to(x1, y1);
  if (x1 === x2) path.line_to(x2, y2);
  else path.cubic_bezier_to(x2, y2, x1, y1 + (y2 - y1) / 2, x2, y1 + (y2 - y1) / 2);
  return window.paint_path(path.build(), color).absolute().left(0).top(0).size_full();
}
function graph(row, width, t, step = STEP) {
  const colors = palette(t), color = colors[row.color % colors.length], mid = HEIGHT / 2;
  const X = (lane) => 11 + lane * step;
  return div().relative().w(width * step + 8).h(HEIGHT).flex_none()
    .children(row.rails.map((rail) => line(X(rail.lane), 0, X(rail.lane), HEIGHT, colors[rail.color % colors.length])))
    .when(row.incoming, (e) => e.child(line(X(row.lane), 0, X(row.lane), mid, color)))
    .children(row.parents.map((parent) => line(X(row.lane), mid, X(parent.lane), HEIGHT, colors[parent.color % colors.length])))
    .child(div().absolute().left(X(row.lane) - 5).top(mid - 5).size(10).rounded_full().bg(t.background).border_2().border_color(color)
      .when(row.refs.some((r) => r.startsWith('HEAD')), (e) => e.bg(color)));
}
function wash(t) {
  const rect = PathBuilder.fill().move_to('0%', '0%').line_to('100%', '0%').line_to('100%', '100%').line_to('0%', '100%').close().build();
  return window.paint_path(rect, Background.linear_gradient(135, t.raised, t.surface)).absolute().top(0).left(0).size_full();
}

export class GitTree {
  constructor() { this.cache = new Map(); this.loading = new Set(); this.operations = new Map(); this.all = true; this.selected = null; this.root = null; }
  key(p) { return JSON.stringify([p.root, this.all]); }
  refresh(p, cx, force = false) {
    if (!p || this.operations.get(p.root)?.busy) return;
    const key = this.key(p), previous = this.cache.get(key);
    if (this.loading.has(key) || (!force && previous && Date.now() - previous.checked < 30000)) return;
    this.loading.add(key);
    const all = this.all;
    cx.spawn(async (cx) => {
      try { this.cache.set(key, { data: await loadGit(exec, p.root, all), checked: Date.now(), error: null }); }
      catch (e) { this.cache.set(key, { data: previous?.data, checked: Date.now(), error: String(e.message ?? e) }); }
      finally { this.loading.delete(key); cx.notify(); }
    });
  }
  sync(p, kind, branch, cx) {
    if (this.operations.get(p.root)?.busy || [true, false].some((all) => this.loading.has(JSON.stringify([p.root, all])))) return;
    this.operations.set(p.root, { busy: true, kind }); cx.notify();
    cx.spawn(async (cx) => {
      try {
        const detail = await syncGit(exec, p.root, kind, branch);
        this.operations.set(p.root, { busy: false, kind, message: kind === 'fetch' ? 'Fetch 완료 · 원격 이력을 갱신했습니다.' : 'Pull 완료 · 현재 브랜치를 동기화했습니다.', detail });
      } catch (e) { this.operations.set(p.root, { busy: false, kind, error: String(e.message ?? e) }); }
      finally {
        // 성공·실패 모두 실제 Git 상태를 다시 읽는다. 실패한 Pull도 fetch는 진행됐을 수 있다.
        for (const all of [true, false]) {
          const cached = this.cache.get(JSON.stringify([p.root, all]));
          if (cached) cached.checked = 0;
        }
        this.refresh(p, cx, true); cx.notify();
      }
    });
  }
  render(projects, cx) {
    const t = theme(), p = projects.find((p) => p.root === this.root) ?? projects[0];
    if (!p) return div().p(18).text_color(t.muted).child('이 공간에 연결된 저장소가 없습니다.');
    // 공간 변경을 render에서 감지하되 외부 실행은 task에서 수행한다.
    this.refresh(p, cx);
    const cached = this.cache.get(this.key(p)), data = cached?.data, loading = this.loading.has(this.key(p));
    const operation = this.operations.get(p.root), busy = Boolean(operation?.busy);
    const pullUnavailable = busy || loading || !data || Boolean(cached?.error) || data.branch === '(detached)' || !data.upstream;
    const selected = data?.rows.find((r) => r.hash === this.selected);
    const panelWidth = this.width ?? 400;
    const step = Math.min(STEP, Math.max(2, (panelWidth * 0.3 - 8) / (data?.width ?? 1)));
    const textWidth = Math.max(60, panelWidth - 40 - (data?.width ?? 1) * step);
    return v_flex().id('git-tree').w_full().min_w(0).flex_1().min_h(0).gap(0)
      .on_size_change((size, cx) => {
        // Herdr의 실제 배치 치수는 zoom이 적용돼 있으므로 스타일 단위로 환산한다.
        const width = size.width / (Number(settings().zoom) || 1);
        if (this.width !== width) { this.width = width; cx.notify(); }
      })
      .child(v_flex().flex_none().p(12).gap(10).border_b(1).border_color(t.border)
        .when(projects.length > 1, (e) => e.child(h_flex().flex_wrap().gap(4).children(projects.map((item) => action(`git-repo-${item.name}`, item.name, p.root === item.root, t, (cx) => { this.root = item.root; this.selected = null; cx.notify(); })))))
        .child(v_flex().relative().overflow_hidden().p(12).gap(8).rounded(9).bg(t.raised).border_1().border_color(t.border)
          .child(wash(t))
          .child(h_flex().gap(7).items_center()
            .child(svg(icon('git-branch')).size(14).text_color(t.ansi6))
            .child(div().flex_1().min_w(0).text_size(12).font_semibold().truncate().child(p.name))
            .child(div().text_size(9.5).text_color(t.dim).child('REPOSITORY')))
          .child(h_flex().gap(6).items_center()
            .child(div().flex_1().min_w(0).text_size(18).font_semibold().text_color(t.ansi6).truncate().tooltip(data?.branch ?? p.root).child(data?.branch === '(detached)' ? 'Detached HEAD' : data?.branch ?? '불러오는 중…'))
            .when(Boolean(data), (e) => e.child(pill(data.dirty ? `변경 ${data.dirty}` : 'Clean', data.dirty ? t.ansi3 : t.ansi2, t))))
          .when(Boolean(data), (e) => e.child(h_flex().gap(8).text_size(10.5).text_color(t.dim)
            .child(div().flex_1().min_w(0).truncate().child(data.upstream ?? '연결된 upstream 없음'))
            .when(Boolean(data.upstream), (e) => e.child(div().text_color(t.muted).child(`↑ ${data.ahead}  ↓ ${data.behind}`)))))
          .child(h_flex().gap(6).items_center().pt(2)
            .child(action('git-fetch', busy && operation.kind === 'fetch' ? 'Fetching…' : 'Fetch', false, t, (cx) => this.sync(p, 'fetch', data?.branch, cx), busy || loading)
              .tooltip(`모든 원격 이력 갱신 · 작업 파일 유지\n${p.root}`))
            .child(action('git-pull', busy && operation.kind === 'pull' ? 'Pulling…' : 'Pull ↓', true, t, (cx) => this.sync(p, 'pull', data?.branch, cx), pullUnavailable)
              .tooltip(!data?.upstream ? 'upstream이 연결된 브랜치에서 사용할 수 있습니다.' : `${data.branch}에 fast-forward만 적용\n${p.root}`))))
        .child(h_flex().gap(4).items_center()
          .child(action('git-all', '모든 브랜치', this.all, t, (cx) => { this.all = true; this.selected = null; cx.notify(); }))
          .child(action('git-current', '현재 브랜치', !this.all, t, (cx) => { this.all = false; this.selected = null; cx.notify(); }))
          .child(div().flex_1())
          .child(action('git-refresh', loading ? '갱신 중' : '새로고침', false, t, (cx) => { this.refresh(p, cx, true); cx.notify(); }, busy || loading))))
      .when(Boolean(operation && !busy), (e) => e.child(h_flex().px(12).py(7).gap(6).items_start()
        .child(div().flex_1().min_w(0).text_size(10.5).text_color(operation.error ? t.ansi3 : t.ansi2).truncate()
          .tooltip(operation.error ?? operation.detail ?? operation.message).child(operation.error ? `실패 · ${operation.error.split('\n')[0]}` : operation.message))
        .child(action('git-operation-dismiss', '×', false, t, (cx) => { this.operations.delete(p.root); cx.notify(); }))))
      .when(Boolean(cached?.error), (e) => e.child(div().px(12).py(8).text_size(11).text_color(t.ansi3).child(`${cached.error}${data ? ' · 마지막 정상 기록 표시' : ''}`)))
      .when(!cached, (e) => e.child(div().p(18).text_color(t.dim).child('커밋 흐름을 불러오고 있습니다…')))
      .when(Boolean(data), (e) => e
        .child(h_flex().px(14).py(8).text_size(9.5).text_color(t.dim)
          .child(div().flex_1().child('COMMIT HISTORY'))
          .child(div().child(`${data.rows.length} COMMITS · 로컬 기준`)))
        .child(v_flex().id(`git-log-${p.name}-${this.all}`).w_full().min_w(0).flex_1().min_h(0).overflow_y_scrollbar().overflow_x_hidden().px(8)
          .when(!data.rows.length, (e) => e.child(div().p(12).text_color(t.dim).child('아직 커밋이 없습니다.')))
          .children(data.rows.map((row) => {
            const color = palette(t)[row.color % 6], chosen = row.hash === this.selected;
            return h_flex().id(`git-commit-${row.hash}`).w(Math.max(80, panelWidth - 16)).h(HEIGHT).flex_none().gap(8).rounded(6)
              .cursor_pointer().bg(chosen ? t.selected : t.background).hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { this.selected = chosen ? null : row.hash; cx.notify(); })
              .child(graph(row, data.width, t, step))
              .child(v_flex().w(textWidth).flex_none().min_w(0).overflow_hidden().justify_center().gap(4).pr(6)
                .when(row.refs.length > 0, (e) => e.child(h_flex().w_full().gap(4).overflow_hidden().children(row.refs.slice(0, 2).map((ref) => pill(ref, ref.startsWith('HEAD') ? t.ansi6 : color, t, (textWidth - 24) / Math.min(row.refs.length, 2))))
                  .when(row.refs.length > 2, (e) => e.child(div().text_size(10).text_color(t.dim).tooltip(row.refs.join('\n')).child(`+${row.refs.length - 2}`)))))
                .child(div().w_full().min_w(0).text_size(11.5).font_medium().truncate().tooltip(row.subject).child(row.subject))
                .child(h_flex().w_full().gap(7).text_size(10).text_color(t.dim)
                  .child(div().text_color(color).font_family('JetBrainsMono Nerd Font Mono').child(row.hash.slice(0, 7)))
                  .child(div().flex_1().min_w(0).truncate().tooltip(row.author).child(row.author))
                  .child(div().flex_none().tooltip(row.date).child(dateLabel(row.date)))));
          }))
          .when(data.rows.length === 80, (e) => e.child(div().p(10).text_size(10).text_color(t.dim).child('최근 80개 커밋 · 아래로 이어지는 선은 이전 이력입니다.')))))
      .when(Boolean(selected), (e) => e.child(v_flex().id('git-detail').flex_none().max_h(190).overflow_y_scrollbar().p(12).gap(7).bg(t.raised).border_t(1).border_color(t.border)
        .child(h_flex().items_center().gap(5)
          .child(div().flex_1().text_size(10).font_medium().text_color(t.ansi6).child('COMMIT DETAIL'))
          .child(action('git-detail-close', '닫기', false, t, (cx) => { this.selected = null; cx.notify(); })))
        .child(div().text_size(12).child(selected.message || selected.subject))
        .child(div().text_size(10.5).text_color(t.muted).child(`${selected.author} · ${selected.date.replace('T', ' ')}`))
        .child(div().text_size(10).text_color(t.dim).font_family('JetBrainsMono Nerd Font Mono').child(selected.hash))
        .child(div().text_size(10).text_color(t.dim).child(`부모 ${selected.parents.map((p) => p.hash.slice(0, 7)).join(' · ') || '없음 · 첫 커밋'}`))));
  }
}
