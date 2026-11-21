import { extname } from "node:path";

// A grammar from @vscode/tree-sitter-wasm and two queries over it: the
// definitions, each node captured as @definition.<kind> with its name as
// @name, and the identifiers counted as uses, captured as @use.
export interface LanguageSpec {
  id: string;
  grammar: string;
  definitions: string;
  uses: string;
}

const TYPESCRIPT_DEFINITIONS = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(function_signature name: (identifier) @name) @definition.function
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function
(class_declaration name: (type_identifier) @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(method_definition name: (property_identifier) @name) @definition.method
(method_signature name: (property_identifier) @name) @definition.method
(abstract_method_signature name: (property_identifier) @name) @definition.method
(public_field_definition name: (property_identifier) @name value: [(arrow_function) (function_expression)]) @definition.method
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(internal_module name: (identifier) @name) @definition.module
(program (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable))
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
`;

const TYPESCRIPT_USES = `
[(identifier) (property_identifier) (type_identifier) (shorthand_property_identifier) (shorthand_property_identifier_pattern)] @use
`;

const JAVASCRIPT_DEFINITIONS = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function
(class_declaration name: (identifier) @name) @definition.class
(method_definition name: (property_identifier) @name) @definition.method
(field_definition property: (property_identifier) @name value: [(arrow_function) (function_expression)]) @definition.method
(program (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable))
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
`;

const JAVASCRIPT_USES = `
[(identifier) (property_identifier) (shorthand_property_identifier) (shorthand_property_identifier_pattern)] @use
`;

const PYTHON_DEFINITIONS = `
(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class
(module (expression_statement (assignment left: (identifier) @name)) @definition.variable)
`;

const GO_DEFINITIONS = `
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_spec name: (type_identifier) @name type: (struct_type)) @definition.class
(type_spec name: (type_identifier) @name type: (interface_type)) @definition.interface
(type_spec name: (type_identifier) @name) @definition.type
(method_elem name: (field_identifier) @name) @definition.method
(source_file (var_declaration (var_spec name: (identifier) @name) @definition.variable))
(source_file (const_declaration (const_spec name: (identifier) @name) @definition.variable))
`;

const RUST_DEFINITIONS = `
(declaration_list (function_item name: (identifier) @name) @definition.method)
(declaration_list (function_signature_item name: (identifier) @name) @definition.method)
(function_item name: (identifier) @name) @definition.function
(struct_item name: (type_identifier) @name) @definition.class
(union_item name: (type_identifier) @name) @definition.class
(enum_item name: (type_identifier) @name) @definition.enum
(type_item name: (type_identifier) @name) @definition.type
(trait_item name: (type_identifier) @name) @definition.interface
(mod_item name: (identifier) @name) @definition.module
(macro_definition name: (identifier) @name) @definition.function
(source_file (const_item name: (identifier) @name) @definition.variable)
(source_file (static_item name: (identifier) @name) @definition.variable)
`;

const JAVA_DEFINITIONS = `
(class_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(annotation_type_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.method
`;

const TYPESCRIPT: LanguageSpec = {
  id: "typescript",
  grammar: "tree-sitter-typescript.wasm",
  definitions: TYPESCRIPT_DEFINITIONS,
  uses: TYPESCRIPT_USES,
};

const LANGUAGES: Record<string, LanguageSpec> = {
  ".ts": TYPESCRIPT,
  ".mts": TYPESCRIPT,
  ".cts": TYPESCRIPT,
  ".tsx": { ...TYPESCRIPT, id: "tsx", grammar: "tree-sitter-tsx.wasm" },
  ...Object.fromEntries(
    [".js", ".jsx", ".mjs", ".cjs"].map((extension) => [
      extension,
      {
        id: "javascript",
        grammar: "tree-sitter-javascript.wasm",
        definitions: JAVASCRIPT_DEFINITIONS,
        uses: JAVASCRIPT_USES,
      },
    ]),
  ),
  ".py": {
    id: "python",
    grammar: "tree-sitter-python.wasm",
    definitions: PYTHON_DEFINITIONS,
    uses: "(identifier) @use",
  },
  ".go": {
    id: "go",
    grammar: "tree-sitter-go.wasm",
    definitions: GO_DEFINITIONS,
    uses: "[(identifier) (field_identifier) (type_identifier) (package_identifier)] @use",
  },
  ".rs": {
    id: "rust",
    grammar: "tree-sitter-rust.wasm",
    definitions: RUST_DEFINITIONS,
    uses: "[(identifier) (field_identifier) (type_identifier)] @use",
  },
  ".java": {
    id: "java",
    grammar: "tree-sitter-java.wasm",
    definitions: JAVA_DEFINITIONS,
    uses: "[(identifier) (type_identifier)] @use",
  },
};

export function languageOf(path: string): LanguageSpec | undefined {
  const extension = extname(path).toLowerCase();
  return Object.hasOwn(LANGUAGES, extension) ? LANGUAGES[extension] : undefined;
}

export function allLanguages(): LanguageSpec[] {
  return [...new Map(Object.values(LANGUAGES).map((spec) => [spec.id, spec])).values()];
}
