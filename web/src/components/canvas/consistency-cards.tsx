import { useEffect, useMemo, useRef, useState } from "react";
import { App, Input, Modal, Popconfirm, Select } from "antd";
import { PencilLine, Plus, Shirt, Trash2, UserRound, X } from "lucide-react";

import type { CanvasTheme } from "@/lib/canvas-theme";
import { CARD_KIND_LABEL, CARD_MAX_IMAGES, SCENE_TEMPLATES } from "@/lib/consistency-card";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useCardStore, type CardDraft, type CardImage, type CardKind, type ConsistencyCard } from "@/stores/use-card-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type Props = {
    theme: CanvasTheme;
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    onInsertCard: (card: ConsistencyCard) => void;
    onInsertText: (text: string, title: string) => void;
};

const KIND_ICON = { product: Shirt, person: UserRound };
const KIND_EMPTY = {
    product: "上传产品的多角度图，出图时锁住款式和细节。",
    person: "上传模特的正脸、侧脸、全身图，出图时锁住同一张脸。",
};

function StoredImg({ storageKey, className }: { storageKey?: string; className?: string }) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        let alive = true;
        void resolveImageUrl(storageKey, "").then((next) => alive && setUrl(next));
        return () => {
            alive = false;
        };
    }, [storageKey]);
    return url ? <img src={url} alt="" className={className} draggable={false} /> : <div className={className} />;
}

// 画布左侧面板的“一致性卡”页：管理产品卡 / 人物卡，点击卡片把它作为一个分组放到画布上。
export function ConsistencyCardsTab({ theme, nodes, selectedNodeIds, onInsertCard, onInsertText }: Props) {
    const cards = useCardStore((state) => state.cards);
    const [draft, setDraft] = useState<CardDraft | null>(null);
    const selectedImages = useMemo(
        () =>
            nodes.flatMap((node): CardImage[] => {
                const meta = node.metadata;
                if (!selectedNodeIds.has(node.id) || node.type !== CanvasNodeType.Image || !meta?.storageKey || !meta.naturalWidth || !meta.naturalHeight) return [];
                return [{ storageKey: meta.storageKey, width: meta.naturalWidth, height: meta.naturalHeight, bytes: meta.bytes || 0, mimeType: meta.mimeType || "image/png" }];
            }),
        [nodes, selectedNodeIds],
    );
    const flatButton = "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition hover:bg-black/5 dark:hover:bg-white/10";

    return (
        <div className="hide-scrollbar h-full overflow-y-auto px-3 pb-4 pt-1" style={{ color: theme.node.text }}>
            {(["product", "person"] as CardKind[]).map((kind) => {
                const Icon = KIND_ICON[kind];
                const list = cards.filter((card) => card.kind === kind);
                return (
                    <section key={kind} className="mb-4">
                        <div className="mb-1.5 flex items-center justify-between">
                            <span className="flex items-center gap-1.5 text-xs font-semibold opacity-70">
                                <Icon className="size-3.5" />
                                {CARD_KIND_LABEL[kind]}
                            </span>
                            <button type="button" className={flatButton} onClick={() => setDraft({ kind, name: "", tag: kind === "person" ? "真人模特" : "", desc: "", images: [] })}>
                                <Plus className="size-3.5" />
                                新建
                            </button>
                        </div>
                        {list.length ? (
                            list.map((card) => (
                                <div key={card.id} role="button" tabIndex={0} title="点击放到画布上" className="group mb-1 flex cursor-pointer items-center gap-2 rounded-lg p-1.5 transition hover:bg-black/5 dark:hover:bg-white/10" onClick={() => onInsertCard(card)}>
                                    <StoredImg storageKey={card.images[0]?.storageKey} className="size-11 shrink-0 rounded-md object-cover" />
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm font-medium">{card.name}</div>
                                        <div className="truncate text-xs opacity-55">
                                            v{card.version} · {card.images.length} 张图{card.tag ? ` · ${card.tag}` : ""}
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        title="编辑"
                                        className="rounded-md p-1.5 opacity-0 transition hover:bg-black/5 group-hover:opacity-70 dark:hover:bg-white/10"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            setDraft(card);
                                        }}
                                    >
                                        <PencilLine className="size-3.5" />
                                    </button>
                                </div>
                            ))
                        ) : (
                            <div className="rounded-lg border border-dashed px-2.5 py-2 text-xs leading-5 opacity-55" style={{ borderColor: theme.toolbar.border }}>
                                {KIND_EMPTY[kind]}
                            </div>
                        )}
                    </section>
                );
            })}

            <section className="mb-4">
                <div className="mb-1.5 text-xs font-semibold opacity-70">场景模板</div>
                <div className="flex flex-wrap gap-1.5">
                    {SCENE_TEMPLATES.map((scene) => (
                        <button key={scene.name} type="button" title="点击放一个文本节点到画布上" className="rounded-full border px-2.5 py-1 text-xs transition hover:bg-black/5 dark:hover:bg-white/10" style={{ borderColor: theme.toolbar.border }} onClick={() => onInsertText(scene.text, `场景·${scene.name}`)}>
                            {scene.name}
                        </button>
                    ))}
                </div>
            </section>

            <div className="text-xs leading-5 opacity-55">
                用法：点卡片把它放上画布，从卡片分组的连接点拉线到要生成的图片节点（产品卡、人物卡、场景模板可以同时连上），再写画面描述并生成。分组里的图和锁定文字会一起发给模型。
            </div>

            {draft ? <CardEditor draft={draft} selectedImages={selectedImages} onClose={() => setDraft(null)} /> : null}
        </div>
    );
}

function CardEditor({ draft, selectedImages, onClose }: { draft: CardDraft; selectedImages: CardImage[]; onClose: () => void }) {
    const { message } = App.useApp();
    const saveCard = useCardStore((state) => state.saveCard);
    const removeCard = useCardStore((state) => state.removeCard);
    const [value, setValue] = useState(draft);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const isProduct = value.kind === "product";
    const patch = (next: Partial<CardDraft>) => setValue((prev) => ({ ...prev, ...next }));
    const addImages = (images: CardImage[]) => setValue((prev) => ({ ...prev, images: [...prev.images, ...images.filter((image) => !prev.images.some((item) => item.storageKey === image.storageKey))] }));
    const addable = selectedImages.filter((image) => !value.images.some((item) => item.storageKey === image.storageKey));

    const handleFiles = async (fileList: FileList | null) => {
        const files = Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
        if (!files.length) return;
        setUploading(true);
        try {
            const images: CardImage[] = [];
            for (const file of files) {
                const image = await uploadImage(file);
                if (image.storageKey) images.push({ storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType });
            }
            addImages(images);
        } catch (error) {
            console.error(error);
            message.error("图片读取失败，请换一张试试");
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    const handleSave = () => {
        if (!value.name.trim()) return void message.warning("请先填名称");
        if (!value.images.length) return void message.warning("请至少放一张参考图");
        const card = saveCard({ ...value, name: value.name.trim(), tag: value.tag.trim(), desc: value.desc.trim() });
        message.success(`已保存「${card.name}」v${card.version}`);
        onClose();
    };

    return (
        <Modal
            open
            title={`${value.id ? "编辑" : "新建"}${CARD_KIND_LABEL[value.kind]}`}
            width={560}
            onCancel={onClose}
            destroyOnHidden
            footer={
                <div className="flex items-center gap-2">
                    {value.id ? (
                        <Popconfirm
                            title="删除这张卡？"
                            description="画布上已经放好的分组和已生成的图片不受影响。"
                            okText="删除"
                            cancelText="取消"
                            onConfirm={() => {
                                removeCard(value.id!);
                                onClose();
                            }}
                        >
                            <button type="button" className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-red-500 transition hover:bg-red-500/10">
                                <Trash2 className="size-3.5" />
                                删除
                            </button>
                        </Popconfirm>
                    ) : null}
                    <div className="flex-1" />
                    <button type="button" className="rounded-md px-3 py-1.5 text-sm transition hover:bg-black/5 dark:hover:bg-white/10" onClick={onClose}>
                        取消
                    </button>
                    <button type="button" className="rounded-md bg-stone-900 px-4 py-1.5 text-sm font-medium text-white transition hover:opacity-85 dark:bg-stone-100 dark:text-stone-900" onClick={handleSave}>
                        保存
                    </button>
                </div>
            }
        >
            <div className="space-y-3.5 pt-2 text-sm">
                <label className="block">
                    <div className="mb-1 text-xs opacity-60">名称</div>
                    <Input value={value.name} placeholder={isProduct ? "例如：米白色亚麻衬衫" : "例如：模特小林"} onChange={(event) => patch({ name: event.target.value })} />
                </label>
                <label className="block">
                    <div className="mb-1 text-xs opacity-60">{isProduct ? "品类" : "类型"}</div>
                    {isProduct ? (
                        <Input value={value.tag} placeholder="例如：服装 / 上衣" onChange={(event) => patch({ tag: event.target.value })} />
                    ) : (
                        <Select className="w-full" value={value.tag || "真人模特"} options={["真人模特", "虚拟模特"].map((item) => ({ value: item, label: item }))} onChange={(tag) => patch({ tag })} />
                    )}
                </label>
                <div>
                    <div className="mb-1 text-xs opacity-60">{isProduct ? "参考图（建议 2–4 张：正面、背面、细节，白底最好）" : "参考图（建议 2–4 张：正脸、侧脸、全身）"}</div>
                    <div className="flex flex-wrap gap-2">
                        {value.images.map((image, index) => (
                            <div key={image.storageKey} className="relative size-20" style={{ opacity: index < CARD_MAX_IMAGES ? 1 : 0.4 }}>
                                <StoredImg storageKey={image.storageKey} className="size-20 rounded-lg object-cover" />
                                <button type="button" title="移除" className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-stone-900 text-white" onClick={() => patch({ images: value.images.filter((item) => item.storageKey !== image.storageKey) })}>
                                    <X className="size-3" />
                                </button>
                            </div>
                        ))}
                        <button type="button" disabled={uploading} className="flex size-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-stone-400/60 text-xs opacity-70 transition hover:opacity-100 disabled:opacity-40" onClick={() => fileInputRef.current?.click()}>
                            <Plus className="size-4" />
                            {uploading ? "读取中…" : "上传图片"}
                        </button>
                        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => void handleFiles(event.target.files)} />
                    </div>
                    {addable.length ? (
                        <button type="button" className="mt-2 rounded-md px-2 py-1 text-xs font-medium transition hover:bg-black/5 dark:hover:bg-white/10" onClick={() => addImages(addable)}>
                            ＋ 加入画布上选中的 {addable.length} 张图片
                        </button>
                    ) : null}
                    {value.images.length > CARD_MAX_IMAGES ? <div className="mt-1.5 text-xs opacity-60">放到画布时只使用前 {CARD_MAX_IMAGES} 张，其余变灰的不会发送。</div> : null}
                </div>
                <label className="block">
                    <div className="mb-1 text-xs opacity-60">{isProduct ? "锁定要点（绝对不能变的地方）" : "人物特征"}</div>
                    <Input.TextArea
                        rows={4}
                        value={value.desc}
                        placeholder={isProduct ? "例如：米白色、亚麻面料、左胸有小刺绣 logo、木质纽扣 5 颗、宽松版型" : "例如：25 岁亚洲女性、黑色及肩直发、鹅蛋脸、身高 170、偏瘦"}
                        onChange={(event) => patch({ desc: event.target.value })}
                    />
                </label>
                <div className="rounded-lg bg-black/5 px-3 py-2 text-xs leading-5 opacity-70 dark:bg-white/10">每次保存版本号 +1。放到画布上的分组标题会带版本号，方便回查某张图用的是哪一版。修改卡片不会改动画布上已经放好的旧分组。</div>
            </div>
        </Modal>
    );
}
