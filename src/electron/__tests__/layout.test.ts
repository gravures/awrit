import { describe, expect, test } from 'bun:test';
import { row, column, layout, calculateLayout, dpx, px, auto, findByTag } from '../layout';

describe('Layout System', () => {
  test('create a row with default values', () => {
    const node = row();

    expect(node.width).toEqual({ value: 0, unit: 'auto' });
    expect(node.height).toEqual({ value: 0, unit: 'auto' });
    expect(node.type).toBe('row');
    expect(node.children).toEqual([]);
  });

  test('create a row with custom values', () => {
    const node = row({
      width: dpx(100),
      height: px(200),
    });

    expect(node.width).toEqual({ value: 100, unit: 'dpx' });
    expect(node.height).toEqual({ value: 200, unit: 'px' });
    expect(node.type).toBe('row');
  });

  test('create a column with custom values', () => {
    const node = column({
      width: px(100),
      height: px(200),
    });

    expect(node.width).toEqual({ value: 100, unit: 'px' });
    expect(node.height).toEqual({ value: 200, unit: 'px' });
    expect(node.type).toBe('column');
  });

  test('handle auto sizing', () => {
    const node = row({
      width: auto(),
      height: auto(),
    });

    expect(node.width).toEqual({ value: 0, unit: 'auto' });
    expect(node.height).toEqual({ value: 0, unit: 'auto' });
  });

  test('use dimension utility functions correctly', () => {
    const node = row();
    node.width = px(100);
    node.height = dpx(200);

    expect(node.width).toEqual({ value: 100, unit: 'px' });
    expect(node.height).toEqual({ value: 200, unit: 'dpx' });
  });

  test('add children correctly', () => {
    const parent = row();
    const child1 = row();
    const child2 = row();

    parent.children.push(child1);
    parent.children.push(child2);
    child1.parent = parent;
    child2.parent = parent;

    expect(parent.children.length).toBe(2);
    expect(parent.children[0]).toBe(child1);
    expect(parent.children[1]).toBe(child2);
  });

  test('create a container with correct properties', () => {
    // Create a container with device pixels and DPI 2
    const container = layout(1600, 1200, 2);

    // Root node should be in logical pixels (800x600)
    expect(container.root.width).toEqual({ value: 1600, unit: 'dpx' });
    expect(container.root.height).toEqual({ value: 1200, unit: 'dpx' });
    expect(container.devicePixelRatio).toBe(2);
    expect(container.logicalWidth).toBe(1600);
    expect(container.logicalHeight).toBe(1200);
  });

  test('layout a simple node', () => {
    const container = layout(800, 600);
    calculateLayout(container);

    const l = container.root.computedLayout;

    expect(l.x).toBe(0);
    expect(l.y).toBe(0);
    expect(l.width).toBe(800);
    expect(l.height).toBe(600);
  });

  test('convert display pixels to logical pixels', () => {
    const container = layout(200, 100, 2);

    const node = row({
      width: dpx(200),
      height: dpx(100),
    });

    calculateLayout(container, [node]);

    const l = node.computedLayout;

    // 200 display pixels at a ratio of 2 = 100 logical pixels
    expect(l.width).toBe(100);
    // 100 display pixels at a ratio of 2 = 50 logical pixels
    expect(l.height).toBe(50);
  });

  test('handle row layout with fixed sizes', () => {
    const container = layout(300, 200);

    // Add three children with fixed sizes
    const child1 = row({ width: px(100), height: px(50) });
    const child2 = row({ width: px(100), height: px(50) });
    const child3 = row({ width: px(100), height: px(50) });

    calculateLayout(container, [child1, child2, child3]);

    const children = container.root.children;

    // Children are stacked vertically in the root column
    expect(children[0].computedLayout).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(children[1].computedLayout).toEqual({ x: 0, y: 50, width: 100, height: 50 });
    expect(children[2].computedLayout).toEqual({ x: 0, y: 100, width: 100, height: 50 });
  });

  test('handle column layout with fixed sizes', () => {
    const container = layout(200, 300);
    container.root.type = 'column';

    // Add three children with fixed sizes
    const child1 = row({ width: px(100), height: px(50) });
    const child2 = row({ width: px(100), height: px(50) });
    const child3 = row({ width: px(100), height: px(50) });

    calculateLayout(container, [child1, child2, child3]);

    const children = container.root.children;

    expect(children[0].computedLayout).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(children[1].computedLayout).toEqual({ x: 0, y: 50, width: 100, height: 50 });
    expect(children[2].computedLayout).toEqual({ x: 0, y: 100, width: 100, height: 50 });
  });

  test('handle auto sizing in row layout', () => {
    const container = layout(300, 100);

    // Add three children, the middle one with auto width
    const child1 = row({ width: px(50), height: px(50) });
    const child2 = row({ width: auto(), height: px(50) });
    const child3 = row({ width: px(50), height: px(50) });

    calculateLayout(container, [child1, child2, child3]);

    const children = container.root.children;

    // Children are stacked vertically in the root column
    expect(children[0].computedLayout).toEqual({ x: 0, y: 0, width: 50, height: 50 });
    // Middle child takes full width since it's in a column
    expect(children[1].computedLayout).toEqual({ x: 0, y: 50, width: 300, height: 50 });
    expect(children[2].computedLayout).toEqual({ x: 0, y: 100, width: 50, height: 50 });
  });

  test('handle auto sizing in column layout', () => {
    const container = layout(100, 300);
    container.root.type = 'column';

    // Add three children, the middle one with auto height
    const child1 = row({ width: px(50), height: px(50) });
    const child2 = row({ width: px(50), height: auto() });
    const child3 = row({ width: px(50), height: px(50) });

    calculateLayout(container, [child1, child2, child3]);

    const children = container.root.children;

    expect(children[0].computedLayout).toEqual({ x: 0, y: 0, width: 50, height: 50 });
    // Middle child take remaining space (300 - 50 - 50 = 200)
    expect(children[1].computedLayout).toEqual({ x: 0, y: 50, width: 50, height: 200 });
    expect(children[2].computedLayout).toEqual({ x: 0, y: 250, width: 50, height: 50 });
  });

  test('handle multiple auto children proportionally', () => {
    const container = layout(300, 100);

    // Add three children with auto width
    const child1 = row({ width: auto(), height: px(50) });
    const child2 = row({ width: auto(), height: px(50) });
    const child3 = row({ width: auto(), height: px(50) });

    calculateLayout(container, [child1, child2, child3]);

    const children = container.root.children;

    // In a column layout, auto-width children take full width
    expect(children[0].computedLayout.width).toBe(300);
    expect(children[1].computedLayout.width).toBe(300);
    expect(children[2].computedLayout.width).toBe(300);
  });

  test('handle nested layouts', () => {
    const container = layout(300, 300);

    // Create a parent with two children
    const child1 = row({ width: px(50), height: px(50) });
    const child2 = row({ width: px(50), height: px(50) });

    const parent = row(
      {
        width: px(200),
        height: px(200),
      },
      [child1, child2],
    );

    calculateLayout(container, [parent]);

    expect(parent.computedLayout).toEqual({ x: 0, y: 0, width: 200, height: 200 });

    const children = parent.children;
    expect(children[0].computedLayout).toEqual({ x: 0, y: 0, width: 50, height: 50 });
    expect(children[1].computedLayout).toEqual({ x: 50, y: 0, width: 50, height: 50 });
  });

  test('handle empty node with auto dimensions', () => {
    const container = layout(300, 300);

    const emptyNode = row();

    calculateLayout(container, [emptyNode]);

    // Empty node with auto dimensions take container's size
    expect(emptyNode.computedLayout.width).toBe(300);
    expect(emptyNode.computedLayout.height).toBe(300);
  });

  test('handle complex nested layout', () => {
    const container = layout(300, 200);

    const row1 = row({ height: px(30) }); // Auto width
    const row2 = row(
      { height: auto() }, // Auto width
      [column(), column()],
    );

    calculateLayout(container, [row1, row2]);

    // First row be 300x30
    expect(row1.computedLayout).toEqual({ x: 0, y: 0, width: 300, height: 30 });

    // Second row be 300x170
    expect(row2.computedLayout).toEqual({ x: 0, y: 30, width: 300, height: 170 });

    // Columns each be 150x170
    expect(row2.children[0].computedLayout).toEqual({ x: 0, y: 30, width: 150, height: 170 });
    expect(row2.children[1].computedLayout).toEqual({ x: 150, y: 30, width: 150, height: 170 });
  });
});

describe('Tag System', () => {
  test('create nodes with tags', () => {
    const node = row({ tag: 'header' });
    expect(node.tag).toBe('header');
  });

  test('create nodes without tags', () => {
    const node = row();
    expect(node.tag).toBeUndefined();
  });

  test('find node by tag', () => {
    const container = layout(800, 600);
    const header = row({ tag: 'header' });
    const content = row({ tag: 'content' });
    const untagged = row();

    calculateLayout(container, [header, content, untagged]);

    const foundHeader = findByTag(container, 'header');
    const foundContent = findByTag(container, 'content');
    const notFound = findByTag(container, 'nonexistent');

    expect(foundHeader).toBe(header);
    expect(foundContent).toBe(content);
    expect(notFound).toBeUndefined();
  });

  test('find nested node by tag', () => {
    const container = layout(800, 600);
    const parent = row({ tag: 'parent' });
    const child = row({ tag: 'child' });
    const untaggedChild = row();
    parent.children = [child, untaggedChild];
    child.parent = parent;
    untaggedChild.parent = parent;

    calculateLayout(container, [parent]);

    const foundParent = findByTag(container, 'parent');
    const foundChild = findByTag(container, 'child');

    expect(foundParent).toBe(parent);
    expect(foundChild).toBe(child);
  });

  test('cache is invalidated after layout changes', () => {
    const container = layout(800, 600);
    const header = row({ tag: 'header' });

    calculateLayout(container, [header]);
    const found1 = findByTag(container, 'header');
    expect(found1).toBe(header);

    const newHeader = row({ tag: 'header' });
    calculateLayout(container, [newHeader]);
    const found2 = findByTag(container, 'header');
    expect(found2).toBe(newHeader);
    expect(found2).not.toBe(header);
  });

  test('returns first node with duplicate tag', () => {
    const container = layout(800, 600);
    const header1 = row({ tag: 'header' });
    const header2 = row({ tag: 'header' });

    calculateLayout(container, [header1, header2]);

    const found = findByTag(container, 'header');
    expect(found).toBe(header1);
  });

  test('empty tag returns undefined', () => {
    const container = layout(800, 600);
    const node = row();

    calculateLayout(container, [node]);

    expect(findByTag(container, '')).toBeUndefined();
  });
});
