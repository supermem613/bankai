// Tool plugin index. Bankai ships no product-specific tool plugins.
// Private workflows can compose external CLIs through shell steps instead.
//
// Tool plugins are an OPEN extension point. Step kinds and assertion kinds
// are closed. The boundary keeps tactical CLI knowledge (entrypoint discovery,
// retry policies, argv composition) inside bankai code when a reusable generic
// plugin is worth publishing.
