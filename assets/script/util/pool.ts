// 通用节点对象池：比旧 MyPool 更干净——不再在 put 时销毁 Sprite，而是保留节点，
// 由调用方在 get 后按需重设 spriteFrame / 位置 / 颜色。避免反复 addComponent 的开销。

import { Node, NodePool } from 'cc';

export class NodePoolEx {
    private pool: NodePool = new NodePool();

    /**
     * @param factory 创建新节点的工厂（首次 get 且池空时调用）
     * @param prealloc 预分配数量
     */
    constructor(private factory: () => Node, prealloc = 0) {
        for (let i = 0; i < prealloc; i++) {
            this.pool.put(factory());
        }
    }

    get(): Node {
        const n = this.pool.get();
        return n ? n : this.factory();
    }

    put(node: Node): void {
        this.pool.put(node);
    }

    size(): number {
        return this.pool.size();
    }
}
