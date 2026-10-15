const faces: Record<string, string> = {
  微笑: "🙂", 撇嘴: "😒", 色: "😍", 发呆: "😶", 得意: "😎", 流泪: "😢", 害羞: "😊", 闭嘴: "🤐",
  睡: "😴", 大哭: "😭", 尴尬: "😅", 发怒: "😡", 调皮: "😜", 呲牙: "😁", 惊讶: "😮", 难过: "😞",
  酷: "😎", 抓狂: "😫", 吐: "🤮", 偷笑: "🤭", 愉快: "😊", 白眼: "🙄", 傲慢: "😏", 困: "🥱",
  惊恐: "😱", 憨笑: "😄", 悠闲: "😌", 咒骂: "🤬", 疑问: "❓", 嘘: "🤫", 晕: "😵", 衰: "😩",
  敲打: "🔨", 再见: "👋", 擦汗: "😓", 抠鼻: "👃", 鼓掌: "👏", 坏笑: "😏", 右哼哼: "😤", 左哼哼: "😤",
  哈欠: "🥱", 鄙视: "👎", 委屈: "🥺", 快哭了: "🥹", 阴险: "😈", 亲亲: "😘", 可怜: "🥺",
  破涕为笑: "😂", 捂脸: "🤦", 奸笑: "😏", 机智: "😎", 皱眉: "😟", 耶: "✌️", 吃瓜: "🍉",
  加油: "💪", 汗: "😓", 天啊: "😲", 社会社会: "🙏", 旺柴: "🐶", 好的: "👌", 打脸: "🤦", 哇: "🤩",
  翻白眼: "🙄", 嗯嗯: "🙂‍↕️", 让我看看: "🧐", 叹气: "😮‍💨", 苦涩: "🥲", 裂开: "🫠", Emm: "🤔",
  爱心: "❤️", 心碎: "💔", 玫瑰: "🌹", 凋谢: "🥀", 强: "👍", 弱: "👎", 握手: "🤝", 胜利: "✌️",
  抱拳: "🙏", 勾引: "🫴", 拳头: "✊", OK: "👌", 合十: "🙏", 庆祝: "🎉", 礼物: "🎁", 红包: "🧧",
};

function Faces({ text }: { text: string }) {
  return text.split(/(\[[^\]\n]{1,12}\])/g).map((part, i) => {
    const name = part.slice(1, -1), emoji = part.startsWith("[") ? faces[name] : undefined;
    return emoji ? <span key={i} role="img" aria-label={name} title={part} className="inline-block align-baseline text-[1.15em]">{emoji}</span> : part;
  });
}

export function WechatMessage({ content, revoked = false }: { content: string; revoked?: boolean }) {
  if (revoked) return <p className="text-ink-4">这条消息已撤回</p>;
  const sections = content.split(/(?:^|\n)[ \t]*\[引用\][ \t]*/);
  return <div className="space-y-2 break-words text-[14px] leading-7">
    {sections[0]?.trim() && <p className="whitespace-pre-wrap"><Faces text={sections[0].trim()} /></p>}
    {sections.slice(1).map((quote, i) => {
      const author = /^([^\n:：]{1,100})[:：][ \t]+/.exec(quote);
      const body = author ? quote.slice(author[0].length) : quote;
      return <blockquote key={i} aria-label="引用消息" className="rounded-r-control border-l-2 border-line-strong bg-bg-sunk px-3 py-2 text-[13px] leading-6 text-ink-3">
        <div className="mb-1 text-[11px] font-medium text-ink-4">{author ? `引用 ${author[1]}` : "引用消息"}</div>
        <p className="whitespace-pre-wrap"><Faces text={body.trim()} /></p>
      </blockquote>;
    })}
    {!content && <p className="text-ink-4">[无文字内容]</p>}
  </div>;
}
