import { describe, expect, test } from "bun:test";
import ReactDOMServer from "react-dom/server";
import { SessionModeSelector } from "../../components/chat/SessionModeSelector";

describe("SessionModeSelector", () => {
  // 渲染当前模式名称
  test("renders current mode name", () => {
    const html = ReactDOMServer.renderToString(
      <SessionModeSelector
        modes={[{ id: "default", name: "默认模式" }]}
        currentModeId="default"
        onModeChange={() => {}}
      />,
    );
    expect(html).toContain("默认模式");
  });

  // modes 为空时渲染为空
  test("renders nothing when modes is empty", () => {
    const html = ReactDOMServer.renderToString(
      <SessionModeSelector modes={[]} currentModeId={null} onModeChange={() => {}} />,
    );
    expect(html).toBe("");
  });
});
