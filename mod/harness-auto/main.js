import { View, div } from "gpui-kit";
import { spaces, run, checking } from "herdr";

// 어느 레포에서나 브리핑을 열고, 같은 공간에서 사용자가 닫은 패널은 다시 강제로 열지 않는다.
export default class HarnessAuto extends View {
  render() {
    if (checking()) return div().size(0);
    const space = spaces().find((s) => s.active);
    const key = JSON.stringify([space?.id, space?.machine]);
    if (key !== this.last) {
      this.last = key;
      run(space ? "layout.show" : "layout.hide", { id: "harness" });
    }
    return div().size(0);
  }
}
