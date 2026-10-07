import { embeddingEnv } from "@/lib/env";

/*
 * Sentence embeddings, computed locally inside the Node server with
 * transformers.js (ONNX runtime). No text leaves the machine.
 *
 * Model: all-MiniLM-L6-v2, 384 dimensions, mean pooled and L2 normalised,
 * so cosine similarity equals the dot product. The model files (~23 MB) are
 * downloaded once into .cache/models on first use.
 */

type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

const globalForModel = globalThis as unknown as { veritraceExtractor?: Promise<Extractor> };

async function extractor(): Promise<Extractor> {
  if (!globalForModel.veritraceExtractor) {
    globalForModel.veritraceExtractor = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = `${process.cwd()}/.cache/models`;
      const model = embeddingEnv().EMBEDDING_MODEL;
      return (await pipeline("feature-extraction", model, { dtype: "fp32" })) as unknown as Extractor;
    })();
    // a failed download must not poison every later call
    globalForModel.veritraceExtractor.catch(() => {
      globalForModel.veritraceExtractor = undefined;
    });
  }
  return globalForModel.veritraceExtractor;
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const run = await extractor();
  const output = await run(texts, { pooling: "mean", normalize: true });
  const vectors = output.tolist();
  const dim = embeddingEnv().EMBEDDING_DIM;
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new Error(`Embedding model returned ${v.length} dimensions but EMBEDDING_DIM is ${dim}`);
    }
  }
  return vectors;
}

export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
  if (!vector) throw new Error("Embedding model returned no vector");
  return vector;
}

/** The text that represents a batch in vector space. */
export function batchText(b: { product_name: string; description: string | null }): string {
  return b.description ? `${b.product_name}. ${b.description}` : b.product_name;
}
