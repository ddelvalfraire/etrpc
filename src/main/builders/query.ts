import { z } from "zod";
import type { QueryProcedure, QueryHandler } from "../../shared/types";
import type { Middleware } from "../middleware";

class QueryBuilderWithInput<TInput extends z.ZodType> {
  constructor(
    private readonly inputSchema: TInput,
    private readonly middlewares: ReadonlyArray<Middleware>,
    private readonly metadata?: Readonly<Record<string, unknown>>,
  ) {}

  use(mw: Middleware): QueryBuilderWithInput<TInput> {
    return new QueryBuilderWithInput(this.inputSchema, [...this.middlewares, mw], this.metadata);
  }

  meta(meta: Record<string, unknown>): QueryBuilderWithInput<TInput> {
    return new QueryBuilderWithInput(this.inputSchema, this.middlewares, meta);
  }

  handler<TOutput>(
    fn: QueryHandler<z.infer<TInput>, TOutput>,
  ): QueryProcedure<TInput, TOutput> {
    return {
      _type: "query",
      _inputSchema: this.inputSchema,
      _outputType: undefined as unknown as TOutput,
      handler: fn,
      _middleware: this.middlewares,
      _meta: this.metadata,
    };
  }
}

class QueryBuilderInitial {
  private readonly middlewares: ReadonlyArray<Middleware>;
  private readonly metadata?: Readonly<Record<string, unknown>>;

  constructor(middlewares: ReadonlyArray<Middleware> = [], metadata?: Readonly<Record<string, unknown>>) {
    this.middlewares = middlewares;
    this.metadata = metadata;
  }

  use(mw: Middleware): QueryBuilderInitial {
    return new QueryBuilderInitial([...this.middlewares, mw], this.metadata);
  }

  meta(meta: Record<string, unknown>): QueryBuilderInitial {
    return new QueryBuilderInitial(this.middlewares, meta);
  }

  input<T extends z.ZodType>(schema: T): QueryBuilderWithInput<T> {
    return new QueryBuilderWithInput(schema, this.middlewares, this.metadata);
  }

  handler<TOutput>(
    fn: QueryHandler<void, TOutput>,
  ): QueryProcedure<z.ZodVoid, TOutput> {
    return {
      _type: "query",
      _inputSchema: z.void(),
      _outputType: undefined as unknown as TOutput,
      handler: fn as QueryHandler<void, TOutput>,
      _middleware: this.middlewares,
      _meta: this.metadata,
    };
  }
}

export function query(): QueryBuilderInitial {
  return new QueryBuilderInitial();
}
