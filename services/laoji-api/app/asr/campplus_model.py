# Copyright FunASR contributors. MIT License.
# Modified from 3D-Speaker and reduced to the CAM++ inference network.
"""Minimal CAM++ speaker embedding network used by LaoJi.

Derived from the MIT-licensed FunASR CAM++ implementation, which in turn is
based on 3D-Speaker. Only the network required to load existing CAM++ speaker
weights is retained here.
"""

from collections import OrderedDict

import torch

from app.asr.campplus_components import (
    CAMDenseTDNNBlock,
    DenseLayer,
    FCM,
    StatsPool,
    TDNNLayer,
    TransitLayer,
    get_nonlinear,
)


class CAMPPlus(torch.nn.Module):
    def __init__(
        self,
        feat_dim=80,
        embedding_size=192,
        growth_rate=32,
        bn_size=4,
        init_channels=128,
        config_str="batchnorm-relu",
        memory_efficient=True,
        output_level="segment",
        **_kwargs,
    ):
        super().__init__()
        self.head = FCM(feat_dim=feat_dim)
        channels = self.head.out_channels
        self.output_level = output_level
        self.xvector = torch.nn.Sequential(
            OrderedDict(
                [
                    (
                        "tdnn",
                        TDNNLayer(
                            channels,
                            init_channels,
                            5,
                            stride=2,
                            dilation=1,
                            padding=-1,
                            config_str=config_str,
                        ),
                    )
                ]
            )
        )
        channels = init_channels
        for index, (num_layers, kernel_size, dilation) in enumerate(
            zip((12, 24, 16), (3, 3, 3), (1, 2, 2))
        ):
            block = CAMDenseTDNNBlock(
                num_layers=num_layers,
                in_channels=channels,
                out_channels=growth_rate,
                bn_channels=bn_size * growth_rate,
                kernel_size=kernel_size,
                dilation=dilation,
                config_str=config_str,
                memory_efficient=memory_efficient,
            )
            self.xvector.add_module(f"block{index + 1}", block)
            channels += num_layers * growth_rate
            self.xvector.add_module(
                f"transit{index + 1}",
                TransitLayer(channels, channels // 2, bias=False, config_str=config_str),
            )
            channels //= 2

        self.xvector.add_module("out_nonlinear", get_nonlinear(config_str, channels))
        if self.output_level == "segment":
            self.xvector.add_module("stats", StatsPool())
            self.xvector.add_module(
                "dense",
                DenseLayer(channels * 2, embedding_size, config_str="batchnorm_"),
            )
        elif self.output_level != "frame":
            raise ValueError("output_level must be segment or frame")

        for module in self.modules():
            if isinstance(module, (torch.nn.Conv1d, torch.nn.Linear)):
                torch.nn.init.kaiming_normal_(module.weight.data)
                if module.bias is not None:
                    torch.nn.init.zeros_(module.bias)

    def forward(self, features):
        output = self.head(features.permute(0, 2, 1))
        output = self.xvector(output)
        return output.transpose(1, 2) if self.output_level == "frame" else output
