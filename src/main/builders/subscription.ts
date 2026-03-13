import { z } from "zod";
import type { SubscriptionProcedure, SubscriptionHandler } from "../../shared/types";
import type { Middleware } from "../middleware";

class SubscriptionBuilderFinal<
  TInput extends z.ZodType | undefined,
  TOutputSchema extends z.ZodType,
> {
  constructor(
    private readonly inputSchema: TInput,
    private readonly outputSchema: TOutputSchema,
    private readonly middlewares: ReadonlyArray<Middleware>,
    private readonly metadata?: Readonly<Record<string, unknown>>,
  ) {}

  use(mw: Middleware): SubscriptionBuilderFinal<TInput, TOutputSchema> {
    return new SubscriptionBuilderFinal(this.inputSchema, this.outputSchema, [...this.middlewares, mw], this.metadata);
  }

  handler(
    fn: SubscriptionHandler<
      TInput extends z.ZodType ? z.infer<TInput> : void,
      z.infer<TOutputSchema>
    >,
  ): SubscriptionProcedure<
    TInput extends z.ZodType ? TInput : z.ZodVoid,
    z.infer<TOutputSchema>
  > {
    const finalInput = (this.inputSchema ?? z.void()) as TInput extends z.ZodType
      ? TInput
      : z.ZodVoid;

    return {
      _type: "subscription",
      _inputSchema: finalInput,
      _outputSchema: this.outputSchema,
      _outputType: undefined as unknown as z.infer<TOutputSchema>,
      handler: fn as unknown as SubscriptionHandler<
        z.infer<TInput extends z.ZodType ? TInput : z.ZodVoid>,
        z.infer<TOutputSchema>
      >,
      _middleware: this.middlewares,
      _meta: this.metadata,
    };
  }
}

class SubscriptionBuilderWithInput<TInput extends z.ZodType> {
  constructor(
    private readonly inputSchema: TInput,
    private readonly middlewares: ReadonlyArray<Middleware>,
    private readonly metadata?: Readonly<Record<string, unknown>>,
  ) {}

  use(mw: Middleware): SubscriptionBuilderWithInput<TInput> {
    return new SubscriptionBuilderWithInput(this.inputSchema, [...this.middlewares, mw], this.metadata);
  }

  output<T extends z.ZodType>(schema: T): SubscriptionBuilderFinal<TInput, T> {
    return new SubscriptionBuilderFinal(this.inputSchema, schema, this.middlewares, this.metadata);
  }
}

class SubscriptionBuilderInitial {
  private readonly middlewares: ReadonlyArray<Middleware>;
  private readonly metadata?: Readonly<Record<string, unknown>>;

  constructor(middlewares: ReadonlyArray<Middleware> = [], metadata?: Readonly<Record<string, unknown>>) {
    this.middlewares = middlewares;
    this.metadata = metadata;
  }

  use(mw: Middleware): SubscriptionBuilderInitial {
    return new SubscriptionBuilderInitial([...this.middlewares, mw], this.metadata);
  }

  meta(meta: Record<string, unknown>): SubscriptionBuilderInitial {
    return new SubscriptionBuilderInitial(this.middlewares, meta);
  }

  input<T extends z.ZodType>(schema: T): SubscriptionBuilderWithInput<T> {
    return new SubscriptionBuilderWithInput(schema, this.middlewares, this.metadata);
  }

  output<T extends z.ZodType>(schema: T): SubscriptionBuilderFinal<undefined, T> {
    return new SubscriptionBuilderFinal(undefined, schema, this.middlewares, this.metadata);
  }
}

export function subscription(): SubscriptionBuilderInitial {
  return new SubscriptionBuilderInitial();
}
