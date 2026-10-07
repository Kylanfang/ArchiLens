// Port bench subsystem: measurement wrapper around a lane controller.
`default_nettype none

module port_bench #(
    parameter integer CHANNELS = 1
) (
    input  wire        clk_i,
    input  wire        rst_ni,
    input  wire        req_i,
    output wire        gnt_o,
    output wire [1:0]  stat_o
);

    wire lane_done;
    wire lane_run;

    bench_lane u_lane (
        .clk_i   (clk_i),
        .rst_ni  (rst_ni),
        .run_i   (lane_run),
        .done_o  (lane_done),
        .stat_o  (stat_o)
    );

    // vendor IO primitive — unresolved by design
    SB_IO #(.PIN_TYPE(6'b010100)) u_io (
        .PACKAGE_PIN (req_i),
        .OUTPUT_CLK  (clk_i),
        .D_OUT_0     (gnt_o)
    );

    assign lane_run = req_i;

endmodule

module bench_lane (
    input  wire       clk_i,
    input  wire       rst_ni,
    input  wire       run_i,
    output wire       done_o,
    output wire [1:0] stat_o
);
    reg [7:0] cnt;
    always @(posedge clk_i or negedge rst_ni) begin
        if (!rst_ni)  cnt <= 8'd0;
        else if (run_i) cnt <= cnt + 8'd1;
    end
    assign done_o  = (cnt == 8'hFF);
    assign stat_o  = cnt[1:0];
endmodule
