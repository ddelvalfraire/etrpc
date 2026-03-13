import { z } from "zod";
import type { MutationProcedure, MutationHandler } from "../../shared/types";
import type { Middleware } from "../middleware";

class MutationBuilderWithInput<TInput extends z.ZodType> {
  constructor(
    private readonly inputSchema: TInput,
    private readonly middlewares: ReadonlyArray<Middleware>,
    private readonly metadata?: Readonly<Record<string, unknown>>,
  ) {}

  use(mw: Middleware): MutationBuilderWithInput<TInput> {
    return new MutationBuilderWithInput(this.inputSchema, [...this.middlewares, mw], this.metadata);
  }

  meta(meta: Record<string, unknown>): MutationBuilderWithInput<TInput> {
    return new MutationBuilderWithInput(this.inputSchema, this.middlewares, meta);
  }

  handler<TOutput>(
    fn: MutationHandler<z.infer<TInput>, TOutput>,
  ): MutationProcedure<TInput, TOutput> {
    return {
      _type: "mutation",
      _inputSchema: this.inputSchema,
      _outputType: undefined as unknown as TOutput,
      handler: fn,
      _middleware: this.middlewares,
      _meta: this.metadata,
    };
  }
}

class MutationBuilderInitial {
  private readonly middlewares: ReadonlyArray<Middleware>;
  private readonly metadata?: Readonly<Record<string, unknown>>;

  constructor(middlewares: ReadonlyArray<Middleware> = [], metadata?: Readonly<Record<string, unknown>>) {
    this.middlewares = middlewares;
    this.metadata = metadata;
  }

  use(mw: Middleware): MutationBuilderInitial {
    return new MutationBuilderInitial([...this.middlewares, mw], this.metadata);
  }

  meta(meta: Record<string, unknown>): MutationBuilderInitial {
    return new MutationBuilderInitial(this.middlewares, meta);
  }

  input<T extends z.ZodType>(schema: T): MutationBuilderWithInput<T> {
    return new MutationBuilderWithInput(schema, this.middlewares, this.metadata);
  }

  handler<TOutput>(
    fn: MutationHandler<void, TOutput>,
  ): MutationProcedure<z.ZodVoid, TOutput> {
    return {
      _type: "mutation",
      _inputSchema: z.void(),
      _outputType: undefined as unknown as TOutput,
      handler: fn as MutationHandler<void, TOutput>,
      _middleware: this.middlewares,
      _meta: this.metadata,
    };
  }
}

export function mutation(): MutationBuilderInitial {
  return new MutationBuilderInitial();
}
