import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CompactExpandableRow, CompactSection } from './CompactSection';

describe('CompactSection and CompactExpandableRow mobile touch-scroll safeguards', () => {
  it('uses overflow-x-clip instead of overflow-hidden so touch scrolling and sticky bars are not trapped', () => {
    const { container } = render(
      <CompactSection title="Purchase History" summary="2 orders">
        <div>Row content</div>
      </CompactSection>
    );

    const section = container.querySelector('section');
    expect(section).not.toBeNull();
    expect(section?.className).toContain('overflow-x-clip');
    expect(section?.className).not.toContain('overflow-hidden');
  });

  it('toggles expanded content and preserves vertical touch panning on mobile cards', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <CompactExpandableRow
        title="PO-261125-1001"
        subtitle="25-11-2026 · 2 items"
        rightPrimary="Rs. 4,500"
        isExpanded={false}
        onToggle={onToggle}
        expandedContent={<div>Batch expiry details</div>}
      />
    );

    const toggleBtn = screen.getByRole('button', { expanded: false });
    expect(toggleBtn.className).toContain('touch-pan-y');

    fireEvent.click(toggleBtn);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <CompactExpandableRow
        title="PO-261125-1001"
        subtitle="25-11-2026 · 2 items"
        rightPrimary="Rs. 4,500"
        isExpanded={true}
        onToggle={onToggle}
        expandedContent={<div>Batch expiry details</div>}
      />
    );

    const expandedPanel = screen.getByText('Batch expiry details').parentElement;
    expect(expandedPanel?.className).toContain('touch-pan-y');
    expect(expandedPanel?.className).toContain('overflow-x-clip');
    expect(expandedPanel?.className).not.toContain('overflow-hidden');
  });
});
