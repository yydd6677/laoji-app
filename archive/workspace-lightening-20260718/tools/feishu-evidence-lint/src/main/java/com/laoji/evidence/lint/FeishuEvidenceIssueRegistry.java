package com.laoji.evidence.lint;

import com.android.tools.lint.client.api.IssueRegistry;
import com.android.tools.lint.client.api.Vendor;
import com.android.tools.lint.detector.api.ApiKt;
import com.android.tools.lint.detector.api.Issue;
import java.util.Arrays;
import java.util.List;
import org.jetbrains.annotations.NotNull;

public final class FeishuEvidenceIssueRegistry extends IssueRegistry {
  private static final Vendor VENDOR = new Vendor("LaoJi", "com.laoji.evidence.lint");

  @NotNull
  @Override
  public List<Issue> getIssues() {
    return Arrays.asList(
      FeishuEvidenceDetector.UNKNOWN_CONTROL,
      FeishuEvidenceDetector.UNMAPPED_LISTENER,
      FeishuEvidenceDetector.UNMAPPED_ANIMATION,
      FeishuEvidenceDetector.UNMAPPED_RESOURCE,
      FeishuEvidenceDetector.HIGH_RATE_BRIDGE
    );
  }

  @Override
  public int getApi() {
    return ApiKt.CURRENT_API;
  }

  @Override
  public int getMinApi() {
    return 14;
  }

  @NotNull
  @Override
  public Vendor getVendor() {
    return VENDOR;
  }
}
