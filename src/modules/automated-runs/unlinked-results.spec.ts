import { suggestCaseName } from './unlinked-results.service';

describe('suggestCaseName', () => {
  it('returns null for a missing title', () => {
    expect(suggestCaseName(null)).toBeNull();
  });

  it('strips trailing @tags and collapses the leftover whitespace', () => {
    expect(suggestCaseName('adds an item @smoke')).toBe('adds an item');
    expect(suggestCaseName('adds an item @smoke @TC-CART-001')).toBe('adds an item');
    expect(suggestCaseName('checkout works @TC-OLD-001 fully')).toBe('checkout works fully');
  });

  it('splits on " › " (Playwright’s describe/test title separator) and keeps only the last segment', () => {
    expect(suggestCaseName('cart/cart.spec.ts › Cart › adds an item to the cart')).toBe('adds an item to the cart');
    expect(suggestCaseName('legacy › old checkout @TC-OLD-001')).toBe('old checkout');
  });

  it('returns null when the title is only a tag (nothing left once it is stripped)', () => {
    expect(suggestCaseName('@TC-OLD-001')).toBeNull();
    expect(suggestCaseName('legacy › @TC-OLD-001')).toBeNull();
    expect(suggestCaseName('   ')).toBeNull();
  });

  it('truncates a very long name to 300 characters', () => {
    const long = 'x'.repeat(400);
    const result = suggestCaseName(long);
    expect(result).toHaveLength(300);
  });
});
