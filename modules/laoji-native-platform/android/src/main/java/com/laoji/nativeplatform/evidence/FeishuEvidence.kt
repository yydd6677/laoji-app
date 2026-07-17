package com.laoji.nativeplatform.evidence

import android.view.View
import android.view.ViewGroup
import com.laoji.nativeplatform.R

// UI-ANDROID-RUNTIME-001: runtime evidence is supplementary to source-derived
// contracts. It never turns an unmapped View into an approved design.
@Target(
  AnnotationTarget.CLASS,
  AnnotationTarget.FUNCTION,
  AnnotationTarget.PROPERTY,
  AnnotationTarget.FILE,
)
@Retention(AnnotationRetention.BINARY)
annotation class FeishuEvidence(vararg val ids: String)

data class EvidenceRef(
  val id: String,
  val role: String,
  val semanticKey: String,
)

data class EvidenceNode(
  val ref: EvidenceRef?,
  val className: String,
  val visible: Boolean,
  val clickable: Boolean,
  val focusable: Boolean,
  val bounds: IntArray,
  val children: List<EvidenceNode>,
)

data class EvidenceNodeContract(
  val semanticKey: String,
  val role: String,
  val parentSemanticKey: String?,
  val classSimpleName: String? = null,
  val widthDp: Float? = null,
  val heightDp: Float? = null,
)

data class EvidenceTreeContract(
  val evidenceId: String,
  val nodes: List<EvidenceNodeContract>,
  val dimensionToleranceDp: Float = 0.5f,
  val rejectUnmappedVisibleOrActionable: Boolean = true,
)

object FeishuEvidenceRuntime {
  private val evidencePattern = Regex("^(?:CAL|MIN|UI)-[A-Z0-9-]+-[0-9]{3}$")

  fun bind(view: View, id: String, role: String, semanticKey: String): View {
    require(evidencePattern.matches(id)) { "Invalid Feishu evidence id: $id" }
    require(role.isNotBlank()) { "Evidence role must not be blank" }
    require(semanticKey.isNotBlank()) { "Evidence semantic key must not be blank" }
    view.setTag(R.id.laoji_feishu_evidence_ref, EvidenceRef(id, role, semanticKey))
    return view
  }

  fun ref(view: View): EvidenceRef? = view.getTag(R.id.laoji_feishu_evidence_ref) as? EvidenceRef

  fun snapshot(root: View): EvidenceNode {
    val location = IntArray(2)
    root.getLocationOnScreen(location)
    val children = if (root is ViewGroup) {
      (0 until root.childCount).map { index -> snapshot(root.getChildAt(index)) }
    } else {
      emptyList()
    }
    return EvidenceNode(
      ref = ref(root),
      className = root.javaClass.name,
      visible = root.visibility == View.VISIBLE,
      clickable = root.isClickable,
      focusable = root.isFocusable,
      bounds = intArrayOf(location[0], location[1], location[0] + root.width, location[1] + root.height),
      children = children,
    )
  }

  fun validate(root: View, contract: EvidenceTreeContract): List<String> {
    require(evidencePattern.matches(contract.evidenceId)) {
      "Invalid Feishu evidence id: ${contract.evidenceId}"
    }
    require(contract.nodes.map { it.semanticKey }.distinct().size == contract.nodes.size) {
      "Evidence contract semantic keys must be unique"
    }

    data class IndexedNode(val node: EvidenceNode, val mappedParent: EvidenceRef?)

    val indexed = mutableListOf<IndexedNode>()
    fun index(node: EvidenceNode, mappedParent: EvidenceRef?) {
      indexed += IndexedNode(node, mappedParent)
      val nextParent = node.ref ?: mappedParent
      node.children.forEach { child -> index(child, nextParent) }
    }
    index(snapshot(root), null)

    val violations = mutableListOf<String>()
    val mapped = indexed.mapNotNull { indexedNode ->
      indexedNode.node.ref?.let { ref -> Triple(indexedNode, ref, indexedNode.mappedParent) }
    }
    mapped.groupBy { it.second.semanticKey }
      .filterValues { it.size > 1 }
      .forEach { (key, nodes) ->
        violations += "DUPLICATE_SEMANTIC_KEY:$key:${nodes.size}"
      }

    val targetNodes = mapped.filter { it.second.id == contract.evidenceId }
    val actualByKey = targetNodes.associateBy { it.second.semanticKey }
    val expectedByKey = contract.nodes.associateBy { it.semanticKey }

    (expectedByKey.keys - actualByKey.keys).sorted().forEach { key ->
      violations += "MISSING_NODE:$key"
    }
    (actualByKey.keys - expectedByKey.keys).sorted().forEach { key ->
      violations += "UNEXPECTED_NODE:$key"
    }

    val density = root.resources.displayMetrics.density
    fun dimensionDp(bounds: IntArray, horizontal: Boolean): Float {
      val pixels = if (horizontal) bounds[2] - bounds[0] else bounds[3] - bounds[1]
      return pixels / density
    }
    fun checkDimension(
      semanticKey: String,
      dimension: String,
      expected: Float?,
      actual: Float,
    ) {
      if (expected != null && kotlin.math.abs(expected - actual) > contract.dimensionToleranceDp) {
        violations += "WRONG_${dimension.uppercase()}:$semanticKey:expected=$expected:actual=$actual"
      }
    }

    expectedByKey.forEach { (key, expected) ->
      val actual = actualByKey[key] ?: return@forEach
      val node = actual.first.node
      val actualRef = actual.second
      val parentRef = actual.third
      if (actualRef.role != expected.role) {
        violations += "WRONG_ROLE:$key:expected=${expected.role}:actual=${actualRef.role}"
      }
      if (parentRef?.semanticKey != expected.parentSemanticKey) {
        violations += "WRONG_PARENT:$key:expected=${expected.parentSemanticKey}:actual=${parentRef?.semanticKey}"
      }
      if (expected.classSimpleName != null && node.className.substringAfterLast('.') != expected.classSimpleName) {
        violations += "WRONG_CLASS:$key:expected=${expected.classSimpleName}:actual=${node.className}"
      }
      checkDimension(key, "width", expected.widthDp, dimensionDp(node.bounds, horizontal = true))
      checkDimension(key, "height", expected.heightDp, dimensionDp(node.bounds, horizontal = false))
    }

    if (contract.rejectUnmappedVisibleOrActionable) {
      unmappedVisibleOrActionable(root).forEach { view ->
        violations += "UNMAPPED_VIEW:${view.javaClass.name}:${view.contentDescription?.toString().orEmpty()}"
      }
    }
    return violations.sorted()
  }

  fun unmappedVisibleOrActionable(root: View): List<View> {
    val result = mutableListOf<View>()
    fun visit(view: View) {
      val requiresOwnEvidence = view.isClickable || view.isFocusable ||
        !view.contentDescription.isNullOrBlank() || (view.visibility == View.VISIBLE && view !is ViewGroup)
      if (requiresOwnEvidence && ref(view) == null) {
        result += view
      }
      if (view is ViewGroup) {
        for (index in 0 until view.childCount) visit(view.getChildAt(index))
      }
    }
    visit(root)
    return result
  }
}
