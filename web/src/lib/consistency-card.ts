import type { ConsistencyCard } from "@/stores/use-card-store";

// 生成时会被替换成这张卡自己那几张参考图的编号（例如“图1、图2”），让模型分清哪些图是产品、哪些图是人物。
export const CARD_IMAGE_TOKEN = "【本组图片】";
export const CARD_MAX_IMAGES = 4;
export const CARD_KIND_LABEL = { product: "产品卡", person: "人物卡" } as const;

export function cardTitle(card: ConsistencyCard) {
    return `${CARD_KIND_LABEL[card.kind]}·${card.name} v${card.version}`;
}

export function cardLockText(card: ConsistencyCard) {
    if (card.kind === "product") {
        return `【产品一致性】${CARD_IMAGE_TOKEN}是产品「${card.name}」。必须严格还原它的款式、版型、颜色、面料质感、图案以及 logo 的位置和细节，不得增加、删减或改动任何设计元素。${card.desc ? `锁定要点：${card.desc}。` : ""}`;
    }
    return `【人物一致性】${CARD_IMAGE_TOKEN}是人物「${card.name}」。必须是同一个人：保持相同的脸型、五官、发型、肤色和身材比例，不得换脸，不得改变年龄感。${card.desc ? `人物特征：${card.desc}。` : ""}`;
}

export function fillCardImageToken(text: string, labels: string[]) {
    return text.includes(CARD_IMAGE_TOKEN) ? text.split(CARD_IMAGE_TOKEN).join(labels.length ? labels.join("、") : "参考图") : text;
}

export const SCENE_TEMPLATES = [
    { name: "电商主图", text: "电商主图：干净的纯色或浅灰背景，产品居中、完整展示，柔和的棚拍光，无多余道具，画面中不要出现任何文字和水印。照片级真实感，细节清晰。" },
    { name: "模特上身图", text: "模特上身图：参考图中的人物穿着（或使用）参考图中的产品，全身或七分身，姿态自然，简洁的棚拍背景，重点突出产品的上身效果。照片级真实感，细节清晰。" },
    { name: "场景种草图", text: "场景种草图：真实的生活场景，自然光，生活化抓拍感，人物自然地穿着（或使用）产品，有氛围感，适合社交平台种草。照片级真实感，细节清晰。" },
    { name: "视频分镜", text: "视频分镜画面：电影感构图，横幅。这是同一支视频里的一个镜头，人物、服装、产品、光线和色调必须与其他镜头完全一致。本镜头内容：（在这里写这个镜头的画面）" },
];
