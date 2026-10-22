const PROJECT_LABEL_RE = /^project-/;

function route({ labels, products }) {
  if (!Array.isArray(labels)) {
    throw new TypeError('labels must be an array');
  }
  for (const item of labels) {
    if (typeof item !== 'string') {
      throw new TypeError('labels elements must be strings');
    }
  }
  if (!Array.isArray(products)) {
    throw new TypeError('products must be an array');
  }

  // Collect unique project labels, preserving insertion order (lowercase for dedup)
  const seen = new Set();
  const projectLabels = [];
  for (const lbl of labels) {
    if (PROJECT_LABEL_RE.test(lbl)) {
      const key = lbl.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        projectLabels.push(lbl);
      }
    }
  }

  // 1. More than one unique project label → AMBIGUOUS
  if (projectLabels.length > 1) {
    return {
      status: 'AMBIGUOUS',
      projectLabels: [...projectLabels].sort(),
    };
  }

  // 2. No project labels → NEEDS_INPUT
  if (projectLabels.length === 0) {
    return { status: 'NEEDS_INPUT' };
  }

  // 3. Exactly one unique project label
  const singleLabel = projectLabels[0];

  // Case-insensitive search for a matching product
  const product = products.find(
    (p) => p.label.toLowerCase() === singleLabel.toLowerCase()
  );

  if (product) {
    // 3a. Label found in products → ROUTED
    return { status: 'ROUTED', product };
  }

  // 3b. Label not found → NEEDS_REGISTRATION
  return { status: 'NEEDS_REGISTRATION', label: singleLabel };
}

export { route };
