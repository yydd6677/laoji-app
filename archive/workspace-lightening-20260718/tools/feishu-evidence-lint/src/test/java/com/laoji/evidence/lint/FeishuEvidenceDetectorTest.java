package com.laoji.evidence.lint;

import com.android.tools.lint.checks.infrastructure.LintDetectorTest;
import com.android.tools.lint.checks.infrastructure.TestFile;
import com.android.tools.lint.detector.api.Detector;
import com.android.tools.lint.detector.api.Issue;
import java.util.Arrays;
import java.util.List;
import org.jetbrains.annotations.NotNull;

import static com.android.tools.lint.checks.infrastructure.TestFiles.jar;

public final class FeishuEvidenceDetectorTest extends LintDetectorTest {
  @NotNull
  @Override
  protected Detector getDetector() {
    return new FeishuEvidenceDetector();
  }

  @NotNull
  @Override
  protected List<Issue> getIssues() {
    return Arrays.asList(
      FeishuEvidenceDetector.UNKNOWN_CONTROL,
      FeishuEvidenceDetector.UNMAPPED_LISTENER,
      FeishuEvidenceDetector.UNMAPPED_ANIMATION,
      FeishuEvidenceDetector.HIGH_RATE_BRIDGE
    );
  }

  public void testAnnotatedKotlinOwnerCoversViewsListenersAndAnimations() {
    lint()
      .files(
        evidenceAnnotation(),
        androidStubs(),
        kotlin(
          "src/com/laoji/test/MappedView.kt",
          """
            package com.laoji.test

            import android.animation.ValueAnimator
            import android.widget.FrameLayout
            import com.laoji.nativeplatform.evidence.FeishuEvidence

            @FeishuEvidence("UI-TEST-MAPPED-001")
            class MappedView : FrameLayout() {
              init {
                val child = FrameLayout()
                child.setOnClickListener { }
                ValueAnimator.ofFloat(0f, 1f).setDuration(180L)
              }
            }
          """
        ).indented()
      )
      .run()
      .expectClean();
  }

  public void testUnannotatedKotlinOwnerIsRejected() {
    lint()
      .files(
        evidenceAnnotation(),
        androidStubs(),
        kotlin(
          "src/com/laoji/test/UnmappedView.kt",
          """
            package com.laoji.test

            import android.widget.FrameLayout

            class UnmappedView : FrameLayout()
          """
        ).indented()
      )
      .issues(FeishuEvidenceDetector.UNKNOWN_CONTROL)
      .run()
      .expectContains("[FeishuUnknownControl]");
  }

  public void testUnannotatedListenerAndAnimationAreRejected() {
    lint()
      .files(
        evidenceAnnotation(),
        androidStubs(),
        kotlin(
          "src/com/laoji/test/UnmappedBehavior.kt",
          """
            package com.laoji.test

            import android.animation.ValueAnimator
            import android.widget.FrameLayout

            class UnmappedBehavior : FrameLayout() {
              init {
                setOnClickListener { }
                ValueAnimator.ofFloat(0f, 1f).setDuration(180L)
              }
            }
          """
        ).indented()
      )
      .issues(
        FeishuEvidenceDetector.UNMAPPED_LISTENER,
        FeishuEvidenceDetector.UNMAPPED_ANIMATION
      )
      .run()
      .expectContains("[FeishuUnmappedListener]")
      .expectContains("[FeishuUnmappedAnimation]");
  }

  private TestFile evidenceAnnotation() {
    return kotlin(
      "src/com/laoji/nativeplatform/evidence/FeishuEvidence.kt",
      """
        package com.laoji.nativeplatform.evidence

        @Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY, AnnotationTarget.FILE)
        @Retention(AnnotationRetention.BINARY)
        annotation class FeishuEvidence(vararg val ids: String)
      """
    ).indented();
  }

  private TestFile androidViewStub() {
    return java(
      "src/android/view/View.java",
      """
        package android.view;

        public class View {
          public interface OnClickListener { void onClick(View view); }
          public View() { }
          public void setOnClickListener(OnClickListener listener) { }
        }
      """
    ).indented();
  }

  private TestFile androidStubs() {
    return jar(
      "libs/android-stubs.jar",
      androidViewStub(),
      frameLayoutStub(),
      animatorStub(),
      valueAnimatorStub()
    );
  }

  private TestFile frameLayoutStub() {
    return java(
      "src/android/widget/FrameLayout.java",
      """
        package android.widget;

        public class FrameLayout extends android.view.View {
          public FrameLayout() { }
        }
      """
    ).indented();
  }

  private TestFile animatorStub() {
    return java(
      "src/android/animation/Animator.java",
      """
        package android.animation;

        public class Animator { }
      """
    ).indented();
  }

  private TestFile valueAnimatorStub() {
    return java(
      "src/android/animation/ValueAnimator.java",
      """
        package android.animation;

        public class ValueAnimator extends Animator {
          public static ValueAnimator ofFloat(float... values) { return new ValueAnimator(); }
          public ValueAnimator setDuration(long duration) { return this; }
        }
      """
    ).indented();
  }
}
