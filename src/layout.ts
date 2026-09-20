import { Split } from './contracts';
export function removePane(tree: Split | null, paneId: string): Split | null {
  if (!tree) return null;
  if (tree.type === 'leaf') return tree.paneId === paneId ? null : tree;
  const first = removePane(tree.first, paneId), second = removePane(tree.second, paneId);
  return first && second ? { ...tree, first, second } : first || second;
}
export function splitPane(tree: Split, target: string, added: string, direction: 'row' | 'column'): Split {
  if (tree.type === 'leaf') return tree.paneId === target ? { type: 'split', direction, ratio: .5, first: tree, second: { type: 'leaf', paneId: added } } : tree;
  return { ...tree, first: splitPane(tree.first, target, added, direction), second: splitPane(tree.second, target, added, direction) };
}
export function balancedLayout(ids: string[], direction: 'row' | 'column' = 'row'): Split | null {
  if (!ids.length) return null;
  if (ids.length === 1) return { type: 'leaf', paneId: ids[0] };
  const mid = Math.ceil(ids.length / 2);
  return { type: 'split', direction, ratio: mid / ids.length, first: balancedLayout(ids.slice(0, mid), direction === 'row' ? 'column' : 'row')!, second: balancedLayout(ids.slice(mid), direction === 'row' ? 'column' : 'row')! };
}
