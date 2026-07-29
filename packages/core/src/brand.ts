/**
 * The product's machine name: API key prefixes, webhook header names, queue
 * and metric names. Everything new derives from this one constant so that the
 * pending product rename is a one-line change here.
 */
export const PRODUCT_SLUG = 'wolff';

/** `Wolff` in header names such as `X-Wolff-Signature`. */
export const PRODUCT_HEADER = PRODUCT_SLUG.charAt(0).toUpperCase() + PRODUCT_SLUG.slice(1);

/** The name shown to people, e.g. in the footer of an email. */
export const PRODUCT_NAME = PRODUCT_HEADER;
