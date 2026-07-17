package com.laoji.evidence.lint;

import com.android.tools.lint.client.api.UElementHandler;
import com.android.tools.lint.detector.api.Category;
import com.android.tools.lint.detector.api.Detector;
import com.android.tools.lint.detector.api.Implementation;
import com.android.tools.lint.detector.api.Issue;
import com.android.tools.lint.detector.api.JavaContext;
import com.android.tools.lint.detector.api.Scope;
import com.android.tools.lint.detector.api.Severity;
import com.android.tools.lint.detector.api.SourceCodeScanner;
import com.android.tools.lint.detector.api.XmlContext;
import com.intellij.psi.PsiClass;
import com.android.resources.ResourceFolderType;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;
import org.jetbrains.uast.UCallExpression;
import org.jetbrains.uast.UAnnotated;
import org.jetbrains.uast.UAnnotation;
import org.jetbrains.uast.UClass;
import org.jetbrains.uast.UElement;
import org.jetbrains.uast.UMethod;
import org.jetbrains.uast.UastCallKind;
import org.w3c.dom.Element;

public final class FeishuEvidenceDetector extends Detector implements SourceCodeScanner, Detector.XmlScanner {
  private static final String EVIDENCE_ANNOTATION = "com.laoji.nativeplatform.evidence.FeishuEvidence";
  private static final String VIEW_CLASS = "android.view.View";
  private static final String ANIMATOR_CLASS = "android.animation.Animator";
  private static final String TOOLS_URI = "http://schemas.android.com/tools";

  private static final Implementation SOURCE_IMPLEMENTATION = new Implementation(
    FeishuEvidenceDetector.class,
    EnumSet.of(Scope.JAVA_FILE, Scope.TEST_SOURCES)
  );
  private static final Implementation RESOURCE_IMPLEMENTATION = new Implementation(
    FeishuEvidenceDetector.class,
    Scope.RESOURCE_FILE_SCOPE
  );

  public static final Issue UNKNOWN_CONTROL = Issue.create(
    "FeishuUnknownControl",
    "Android UI control has no Feishu source evidence",
    "Every source-rebuilt Android View owner must declare @FeishuEvidence. "
      + "A comment marker does not satisfy this contract.",
    Category.CORRECTNESS,
    10,
    Severity.ERROR,
    SOURCE_IMPLEMENTATION
  );

  public static final Issue UNMAPPED_LISTENER = Issue.create(
    "FeishuUnmappedListener",
    "Listener has no Feishu behavior contract",
    "Listener ownership and behavior must be traced to a Feishu evidence ID on the containing class or method.",
    Category.CORRECTNESS,
    10,
    Severity.ERROR,
    SOURCE_IMPLEMENTATION
  );

  public static final Issue UNMAPPED_ANIMATION = Issue.create(
    "FeishuUnmappedAnimation",
    "Animation has no Feishu timing contract",
    "Animator construction and animation callbacks require a source-derived evidence annotation.",
    Category.CORRECTNESS,
    10,
    Severity.ERROR,
    SOURCE_IMPLEMENTATION
  );

  public static final Issue UNMAPPED_RESOURCE = Issue.create(
    "FeishuUnmappedResource",
    "Layout node has no Feishu evidence ID",
    "Every node in a LaoJi-owned Android layout must set tools:feishuEvidence to a registered evidence ID.",
    Category.CORRECTNESS,
    10,
    Severity.ERROR,
    RESOURCE_IMPLEMENTATION
  );

  public static final Issue HIGH_RATE_BRIDGE = Issue.create(
    "FeishuHighRateBridge",
    "High-frequency UI or audio callback crosses the JS bridge",
    "Draw, touch, move, scroll, waveform, PCM and level callbacks must remain native. "
      + "Only low-frequency semantic events may cross Expo/Fabric.",
    Category.PERFORMANCE,
    10,
    Severity.ERROR,
    SOURCE_IMPLEMENTATION
  );

  @Override
  public List<Class<? extends UElement>> getApplicableUastTypes() {
    return Arrays.asList(UClass.class, UCallExpression.class);
  }

  @Override
  public UElementHandler createUastHandler(@NotNull JavaContext context) {
    return new UElementHandler() {
      @Override
      public void visitClass(@NotNull UClass node) {
        PsiClass psiClass = node.getJavaPsi();
        if (context.getEvaluator().extendsClass(psiClass, VIEW_CLASS, false) && !hasEvidence(node)) {
          context.report(
            UNKNOWN_CONTROL,
            node,
            context.getNameLocation(node),
            "View owner " + psiClass.getName() + " must declare @FeishuEvidence"
          );
        }
      }

      @Override
      public void visitCallExpression(@NotNull UCallExpression node) {
        String methodName = node.getMethodName();
        if (node.getKind() == UastCallKind.CONSTRUCTOR_CALL) {
          PsiClass constructed = node.resolve() != null ? node.resolve().getContainingClass() : null;
          if (constructed != null
            && context.getEvaluator().extendsClass(constructed, VIEW_CLASS, false)
            && !hasEvidence(node)) {
            context.report(
              UNKNOWN_CONTROL,
              node,
              context.getLocation(node),
              "View construction must be owned by @FeishuEvidence"
            );
          }
          if (constructed != null
            && context.getEvaluator().extendsClass(constructed, ANIMATOR_CLASS, false)
            && !hasEvidence(node)) {
            context.report(
              UNMAPPED_ANIMATION,
              node,
              context.getLocation(node),
              "Animator construction must be owned by @FeishuEvidence"
            );
          }
        }
        if (methodName == null) return;
        if (isListenerMethod(methodName) && !hasEvidence(node)) {
          context.report(
            UNMAPPED_LISTENER,
            node,
            context.getNameLocation(node),
            "Listener " + methodName + " must be owned by @FeishuEvidence"
          );
        }
        if (isAnimationMethod(methodName) && !hasEvidence(node)) {
          context.report(
            UNMAPPED_ANIMATION,
            node,
            context.getNameLocation(node),
            "Animation " + methodName + " must be owned by @FeishuEvidence"
          );
        }
        if (isBridgeDispatch(methodName, node) && isHighRateOwner(node)) {
          context.report(
            HIGH_RATE_BRIDGE,
            node,
            context.getNameLocation(node),
            "High-frequency callback " + methodName + " must not cross the JS bridge"
          );
        }
      }
    };
  }

  private static boolean hasEvidence(UElement element) {
    UElement current = element;
    while (current != null) {
      if (current instanceof UAnnotated && hasEvidenceAnnotation((UAnnotated) current)) return true;
      current = current.getUastParent();
    }
    return false;
  }

  @Nullable
  private static <T extends UElement> T parentOfType(UElement element, Class<T> type) {
    UElement parent = element.getUastParent();
    while (parent != null) {
      if (type.isInstance(parent)) return type.cast(parent);
      parent = parent.getUastParent();
    }
    return null;
  }

  private static boolean hasEvidenceAnnotation(UAnnotated owner) {
    for (UAnnotation annotation : owner.getUAnnotations()) {
      if (EVIDENCE_ANNOTATION.equals(annotation.getQualifiedName())) return true;
    }
    return false;
  }

  private static boolean isListenerMethod(String methodName) {
    return (methodName.startsWith("setOn") || methodName.startsWith("addOn"))
      && (methodName.endsWith("Listener") || methodName.endsWith("Callback"));
  }

  private static boolean isAnimationMethod(String methodName) {
    return methodName.equals("animate")
      || methodName.equals("startAnimation")
      || methodName.equals("ofFloat")
      || methodName.equals("ofInt")
      || methodName.equals("setDuration");
  }

  private static boolean isBridgeDispatch(String methodName, UCallExpression node) {
    String source = node.asSourceString().toLowerCase();
    return methodName.equals("invoke")
      && (source.contains("eventdispatcher") || source.contains("onsend") || source.contains("emit"));
  }

  private static boolean isHighRateOwner(UElement element) {
    UMethod method = parentOfType(element, UMethod.class);
    if (method == null) return false;
    String name = method.getName().toLowerCase();
    return name.contains("draw")
      || name.contains("touch")
      || name.contains("move")
      || name.contains("scroll")
      || name.contains("pcm")
      || name.contains("wave")
      || name.contains("level");
  }

  @Nullable
  @Override
  public Collection<String> getApplicableElements() {
    return Detector.XmlScanner.ALL;
  }

  @Override
  public void visitElement(@NotNull XmlContext context, @NotNull Element element) {
    if (context.getResourceFolderType() != ResourceFolderType.LAYOUT) return;
    if (!element.hasAttributeNS(TOOLS_URI, "feishuEvidence")) {
      context.report(
        UNMAPPED_RESOURCE,
        element,
        context.getLocation(element),
        "Layout node " + element.getTagName() + " must declare tools:feishuEvidence"
      );
    }
  }
}
