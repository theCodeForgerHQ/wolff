/**
 * Stand-in for https://js.stripe.com served through page.route().
 *
 * There are no Stripe keys here, and the real Stripe.js can't render a
 * Payment Element for a stripe-mock client secret. The stub implements the
 * surface @stripe/react-stripe-js and PaymentForm use (elements, create,
 * mount, confirmPayment) and records what the app passed in, so the test can
 * assert that the client secret came from the server's PaymentIntent.
 */
export const STRIPE_JS_STUB = `
(function () {
  var calls = (window.__stripeStub = { elementsOptions: null, confirmed: null });
  function element(type) {
    return {
      mount: function (node) {
        var el = typeof node === 'string' ? document.querySelector(node) : node;
        el.innerHTML = '<div data-testid="stripe-payment-element">Mock ' + type + ' element</div>';
      },
      on: function () { return this; },
      off: function () { return this; },
      once: function () { return this; },
      update: function () {},
      focus: function () {},
      blur: function () {},
      clear: function () {},
      collapse: function () {},
      unmount: function () {},
      destroy: function () {},
    };
  }
  function Stripe(key) {
    return {
      _registerWrapper: function () {},
      registerAppInfo: function () {},
      elements: function (options) {
        calls.elementsOptions = options;
        return {
          create: function (type) { return element(type); },
          getElement: function () { return null; },
          update: function () {},
          submit: function () { return Promise.resolve({}); },
          fetchUpdates: function () { return Promise.resolve({}); },
        };
      },
      createToken: function () { return Promise.resolve({}); },
      createPaymentMethod: function () { return Promise.resolve({}); },
      confirmCardPayment: function () { return Promise.resolve({}); },
      confirmPayment: function (params) {
        calls.confirmed = { publishableKey: key, redirect: params.redirect };
        return Promise.resolve({ paymentIntent: { status: 'succeeded' } });
      },
    };
  }
  window.Stripe = Stripe;
})();
`;
