import { nanoid } from "nanoid";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { localForageStorage } from "@/lib/localforage-storage";
import { registerImageKeyProvider } from "@/services/image-storage";

// 一致性卡：把一个产品或一个人物的参考图和“不能变的要点”固定下来，出图时整组引用。
export type CardKind = "product" | "person";
export type CardImage = { storageKey: string; width: number; height: number; bytes: number; mimeType: string };
export type ConsistencyCard = {
    id: string;
    kind: CardKind;
    name: string;
    tag: string;
    desc: string;
    version: number;
    images: CardImage[];
    createdAt: string;
    updatedAt: string;
};
export type CardDraft = Pick<ConsistencyCard, "kind" | "name" | "tag" | "desc" | "images"> & { id?: string };

type CardStore = {
    cards: ConsistencyCard[];
    saveCard: (draft: CardDraft) => ConsistencyCard;
    removeCard: (id: string) => void;
};

export const useCardStore = create<CardStore>()(
    persist(
        (set, get) => ({
            cards: [],
            // 每次保存版本号 +1，画布上的卡片分组标题会带上版本，方便回查用的是哪一版。
            saveCard: (draft) => {
                const now = new Date().toISOString();
                const old = get().cards.find((card) => card.id === draft.id);
                const card: ConsistencyCard = { ...draft, id: old?.id || nanoid(), version: (old?.version || 0) + 1, createdAt: old?.createdAt || now, updatedAt: now };
                set((state) => ({ cards: old ? state.cards.map((item) => (item.id === card.id ? card : item)) : [...state.cards, card] }));
                return card;
            },
            removeCard: (id) => set((state) => ({ cards: state.cards.filter((card) => card.id !== id) })),
        }),
        { name: "infinite-canvas:consistency_cards", storage: createJSONStorage(() => localForageStorage) },
    ),
);

// 清理未使用图片时把卡片里的参考图算作“在用”；必须等卡片数据读完再回答，否则会被误删。
registerImageKeyProvider(async () => {
    if (!useCardStore.persist.hasHydrated()) await new Promise<void>((resolve) => useCardStore.persist.onFinishHydration(() => resolve()));
    return useCardStore.getState().cards;
});
