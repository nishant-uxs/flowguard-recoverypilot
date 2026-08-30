import { z } from 'zod';

const identifierSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/,
    'must be 3-64 characters using letters, numbers, _ or -',
  );

const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'must be an uppercase ISO 4217 currency code');

const paymentMethodSegmentSchema = z.discriminatedUnion('paymentMethod', [
  z.object({
    paymentMethod: z.literal('upi'),
    segment: z.enum(['collect', 'intent']),
  }),
  z.object({
    paymentMethod: z.literal('card'),
    segment: z.enum(['domestic', 'international']),
  }),
  z.object({
    paymentMethod: z.literal('netbanking'),
    segment: z.literal('retail'),
  }),
  z.object({
    paymentMethod: z.literal('wallet'),
    segment: z.literal('standard'),
  }),
]);

const paymentStatusSchema = z.enum(['initiated', 'pending', 'succeeded', 'failed', 'cancelled']);

const failureCategorySchema = z.enum([
  'insufficient_funds',
  'issuer_declined',
  'timeout',
  'technical_error',
  'invalid_request',
  'unknown',
]);

export const merchantContextSchema = z
  .object({
    merchantId: identifierSchema,
  })
  .strict();

export const paymentEventSchema = z
  .object({
    eventId: identifierSchema,
    merchantId: identifierSchema,
    paymentId: identifierSchema,
    attemptId: identifierSchema,
    timestamp: z.string().datetime({ offset: true }),
    paymentMethodSegment: paymentMethodSegmentSchema,
    amount: z.number().finite().nonnegative(),
    currency: currencySchema,
    status: paymentStatusSchema,
    failureCategory: failureCategorySchema.optional(),
    latencyMs: z.number().int().nonnegative().optional(),
    retryCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.status === 'failed' && event.failureCategory === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCategory'],
        message: 'is required when status is failed',
      });
    }

    if (event.status !== 'failed' && event.failureCategory !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCategory'],
        message: 'must be omitted unless status is failed',
      });
    }
  });

export type MerchantContext = z.infer<typeof merchantContextSchema>;
export type PaymentMethodSegment = z.infer<typeof paymentMethodSegmentSchema>;
export type PaymentEvent = z.infer<typeof paymentEventSchema>;
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;
export type FailureCategory = z.infer<typeof failureCategorySchema>;

export {
  currencySchema,
  failureCategorySchema,
  identifierSchema,
  paymentMethodSegmentSchema,
  paymentStatusSchema,
};
