import type { TreeNode } from './api';

export function flatten(tree: TreeNode[], acc: string[] = []): string[] {
  for (const n of tree) {
    if (n.type === 'file') acc.push(n.path);
    else flatten(n.children ?? [], acc);
  }
  return acc;
}
