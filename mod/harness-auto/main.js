import { View, div } from "gpui-kit";
import { spaces, run } from "herdr";

// 숨겨진 패널은 스스로 다시 나타날 수 없으므로 별도 mod에서 공간 전환을 처리한다.
// 공간이 바뀔 때만 적용해 현재 공간의 수동 패널 토글을 보존한다.
export default class HarnessAuto extends View {
  render() {
    const space = spaces().find((s) => s.active);
    const key = space ? `${space.id}:${space.machine ?? "local"}` : null;
    if (key !== this.last) {
      this.last = key;
      run(space && !space.machine ? "layout.show" : "layout.hide", { id: "harness" });
    }
    return div().size(0);
  }
}
